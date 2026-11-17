# Dulja Phase 7A — Report engine: definition format, datasets, server-side render, saved views, financial-statement layouts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the report *builder* — a text-defined, diffable `ReportDefinition` JSON format, a closed registry of twenty-six named dataset queries, a server-side renderer producing PDF, XLSX and CSV through a pg-boss job with a status resource, per-tenant clone-and-edit of a definition without a release, saved views that archive rather than delete, and the two financial-statement layouts (profit and loss, balance sheet) the catalogue slices build their definitions on.

**Architecture:** Three layers with one seam each. The **pure** layer is `packages/domain/src/reports/`: the JSON Schema and its generated `ReportDefinition` type, `validateReportDefinition` (which takes the dataset and permission sets as *parameters*, because `packages/domain` imports nothing internal), `renderReport` (grouping, subtotals, totals, sort, direction and formatting → a `RenderedReport` value object), `renderCsv`, the two PDF source builders, and the statement layouts. The **data** layer is `packages/db/src/reports/`: `datasets.ts`, the closed `DatasetId` registry where every member is a named `withTenant` read query whose column references are literal SQL fragments authored in that file — a definition never contributes SQL text (test 27) — plus the `report_definition` / `saved_view` / `report_run` tables and the `reports` seed-pack loader. The **I/O** layer is `apps/worker/src/reports/`: one `ReportRenderer` per format (CSV, ExcelJS, PDF through an ADR-0016 engine), the object store the rendered bytes land in, and the `reporting.render` handler that drives a `report_run` from `queued` to `done`. `apps/api` adds three route modules and one sub-path on 1B's existing `reports` module; nothing in this slice writes a ledger, movement, projection or tax-transaction row.

**Tech Stack:** TypeScript (Bun 1.4 for install/build, Vitest under Node 24 for tests) · PostgreSQL 18 + postgres.js + Drizzle mirrors · Ajv 2020 + `json-schema-to-typescript` · `decimal.js` behind `@dulja/domain`'s `Money` · Hono + `@hono/zod-openapi` + Zod · pg-boss · ExcelJS · the ADR-0016 PDF engine (`typst` binary and/or Playwright Chromium) · `pdfjs-dist` in tests only · Cloudflare R2 through the `ObjectStore` port · Testcontainers.

**Spec:** `C:/Users/Edres101/Desktop/dulja/rebuild-spec.md` (v1.2). Sections this slice implements: §3.2.2 PDF and Spreadsheets rows (spec:1132–1133), §3.3 projections (spec:1204), §3.5 end-user report designer and feature gating (spec:1240–1241), §3.6 "Delphi-serialised report files" on the do-not-carry-over list (spec:1246), §3.9 Localisation (spec:2061), §4.2.1 the report codes and the `auditor` row (spec:2146–2147, 2150, 2163), §4.5 bulk endpoints with async job semantics and a status resource (spec:2206), §4.8 read replicas and graceful degradation (spec:2235, 2237), §4.9 the report-generation SLO (spec:2245), §4.10 RTL/LTR parity on every generated PDF (spec:2253), Part V row 7 (spec:2293) and its sequencing note (spec:2300), Part VI tests 23 and 27, Part I LEGACY-069, LEGACY-077, LEGACY-085.

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 7A — Report engine: definition format, datasets, server-side render, saved views, financial-statement layouts. **Phase:** 7. **Phase gate:** this plan starts only when **5A** is merged and the **Phase 5 definition of done** is green in CI (spec:87). Nothing here needs Phase 6; §6.3 puts `7A → 7B` on a branch that runs in parallel with `6A → 6C → 6B → 6D`.
- **Depends on (merged):** 5A, and transitively 0B, 0D, 0C, 0E, 1A, 1B, 2A, 2B, 2C, 3A, 3B, 3C, 3D, 4A, 4B. Plan 0A helpers consumed by exact name: `startDb`, `Db`, `withTenant` (the **4-argument test** helper), `uuidv7`, `seedTenant`, `Seed`, `lintSchema`, `Violation`, `schemaFingerprint`, `up`, `down`, `listApplied`, `discover`, `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp`, `app.actor_has`, `app.current_actor`, `app.current_tenant`, `app.forbid_change`.
- **Migration numbers:** 0074–0076 — files `0074_create_report_definition.sql`, `0075_create_saved_view_report_run.sql`, `0076_seed_permission_phase7a.sql`, each with its hand-written `NNNN.down.sql`. **ADR numbers:** 0065–0067 (`0065-report-definition-format.md`, `0066-server-side-report-render.md`, `0067-saved-views-and-report-runs.md`).
- **Interfaces consumed:** §4.1 (the Plan 0A produced surface); §4.2.2 (`withTenant`, `TenantContext`, `systemContext`, `createDb`); §4.2.3 (`Logger`, `AppEnv`, `RequestContext`, `ApiConfig`, `readConfig`, **and `AppEnv["Variables"]`'s eighth member `jobs: JobClient` — 3B's amendment A5**, 3b:39, set by the two-line middleware in `apps/api/src/app.ts` from `deps.jobs`; Task 12's `POST …/runs` reads `c.var.jobs` and **this slice adds no `Variables` member of its own**, so A5 must be ratified in §4.2.3 before Task 12 executes); §4.2.4 (`Problem`, `ERRORS`, `ErrCode`, `AppError`, `fromDatabaseError`, and the `PostingError` precedent for a `packages/db` error class); §4.2.5 (`PERMISSION`, `PERMISSIONS`, `PermissionDef`, `PermissionCode`, `requirePermission`, `ScopeSource`, `ROLES`); §4.2.6 (`JOBS`, `JobName`, `JobPayload`, `JobEnvelope`, `JobClient`, `registerHandler`, `JobHandler`, `runJob`, `eachTenant`, `JOB_PROBES`, `log`, `setLogger`); §4.2.7 (`RouteModule`, `buildRoutes`, `ROUTES`, `IdempotencyHeader`, `createApp`, `AppDeps`, `PROBES`); §4.2.8 (`UuidSchema`, `DateSchema`, `TimestampSchema`, `MoneySchema`, `CursorSchema`, `ListEnvelope`, `ListQuery`, `ProblemSchema`, `encodeCursor`, `decodeCursor`, `FILTER_OPS`, `FilterOp`, `FilterClause`, `parseFilters`); §4.2.9 (`idempotency`, `IdempotencyHeader`, `REPLAY_BY_RERUN`, `isReplayByRerun`); §4.2.12 (`startApi`, `StartedApi`, `ApiRequest`, `TEST_ISSUER`); §4.2.13 (`SubPack`, `SUB_PACKS`, `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES`, `LOADERS`, `runLoaders`); §4.3.3 (`app.account_balance`); §4.3.4 (`app.document_line` and the `app.document` header additions); §4.4.1 (the schema-plus-generated-type pattern and `packages/domain/scripts/generate-policy-type.ts`, reused, not re-invented); §4.5.2 (`app.document_event`); §4.5.7 (`app.party`); §4.5.8 (`ObjectStore`, `StoredObject`, `MemoryObjectStore`, `R2ObjectStore`, `R2ObjectStoreOptions`); §4.5.9 (`app.print_template` and the `A4 | A5 | receipt` paper vocabulary); §4.6.1 (the table register — every dataset's source columns); §4.7.3 (`app.inventory_movement`, `app.stock_on_hand`, `app.cost_layer`, `app.cost_consumption`); §4.8.1 (`app.allocation`); §4.8.3 (`app.bank_statement_line`, `app.bank_match`); §4.9.2 (`app.tax_transaction`); §4.16.3 (`reportsRoutes`, `reportsRouteModule`, `ReportCodeSchema`, `trialBalance`, `accountLedger`); §4.17 (`seedTenantV2`, `seedAccount`, `seedBranch`, `seedParty`, `seedDocumentType`, `grantCodes`, `seedItem`, `seedWarehouse`, `seedLot`, `seedUnit`, `seedTaxCode`, `seedPaymentTerm`); §4.17.1 (`sharedDb`, `thinRegression`, `sharedApi`, `grantAdmin`, `fullRegression`, `problemOf`, `REPO_ROOT`, `sourceFiles`, `repoFile`, `postJournal`, `startWorker`, `pdfText`).
- **Interfaces produced:** §4.11.1 verbatim (`ReportDefinition` and `packages/domain/report-definition.schema.json`); §4.11.2 **with the two amendments the Execution-handoff table records** (`statusUrl` becomes `/v1/companies/<companyId>/report-runs/<runId>`, ADR 0067, because §4.2.7 assigns `/v1/jobs/{jobId}` to no module and 6A dropped its own `statusUrl` for the same reason; and the seed file is the `{ definitionVersion, definition }` envelope of §4.16.1, Task 14) — otherwise verbatim: `app.report_definition`, `app.saved_view`, `app.report_run`, `POST …/reports/{code}/runs`, the `reporting.render` job, `renderReport`; §4.16.2's **twenty-six 7A rows** of `DatasetId` in `packages/db/src/reports/datasets.ts` (7B adds none and never edits the file; 7C adds the three Phase 6 rows; 8D the six HR rows); §3.6.2's `accounting.report.export` row and its `auditor` grant; §4.17's `seedReportDefinition`; §4.2.13's `SubPack` member `"reports"` and the `reportsLoader` `PackLoader`. **Beyond §4.11, and named here because 7B and 7C import them:** `STATEMENT_LAYOUTS`, `statementLayout`, `statementDefinition`, `statementSectionFor`, `STATEMENT_SECTION_LABELS`, `StatementKind`, `StatementSection`, `StatementLayout`, `StatementLayoutOptions`, **`STATEMENT_CODES`**, **`statementKindFor`** and **`STATEMENT_EXTRA_FIELDS`** (`packages/domain/src/reports/statement.ts`); `statementRows`, `StatementParams`, **`rowsForDefinition`** and **`assertDefinitionFields`** (`packages/db/src/reports/statement.ts`) — the one row provider and the one field check every run path, store write and seed load goes through. `STATEMENT_CODES` is the binding that tells the run path a definition is a statement; §4.11.1's `dataset.source` remains the only source a non-statement definition names.
- **Owner decisions:** **OD-24** → **Task 15** (isolated). Default written into the plan: the report-designer screen task is **blocked, the slice is not** — Task 15 carries no React code and cannot be started until the owner attaches screenshots and a two-minute operator description; every other task ships without it.
- **Part VI tests owned / re-run:** owned — **none exclusively**. Re-run — **23** (RTL/LTR parity on every generated PDF — labels, numerals, Hijri/Gregorian and column order — **Task 10**, `apps/worker/test/reports/pdf.test.ts`) and **27** (no SQL text across the API — the dataset registry, Tasks 5–7, and the `no-sql-concat`/`no-bare-db` rules in CI). **§3.0.4 rows owned:** none — this slice contributes the builder and the layouts to spec:1047, which 7B owns. **Regression files created / appended:** creates `tests/regression/legacy-077.test.ts` (7A is the plain creator; 9A is a create-if-absent appender under §3.7.3's first corollary, so the file exists exactly once whichever runs first); appends a `describe("… — 7A")` block to `tests/regression/legacy-069.test.ts` (created by 0B) and `tests/regression/legacy-085.test.ts` (created by 0E).
- **Shared namespaces this slice writes into:** document-type codes (§4.14) — **none**. Account codes (§4.15) — **none seeded and none consumed by literal**; the statement layouts group by `app.account.type` (the `account_type` enum), never by an account code, so hazard 33 does not engage. Report codes (§4.16.1) — **none seeded**, and **three named**: 7A ships the format, the validator, the layouts and the loader; the `accounting.profit_and_loss` and `accounting.balance_sheet` **definitions** are 7B's and `accounting.branch_profit_and_loss` is 7C's, and this slice's tests build definitions from `STATEMENT_LAYOUTS` through `seedReportDefinition` rather than seeding a pack file. The three codes appear as the **keys of `STATEMENT_CODES`** (Task 9) — the binding that tells the run path a definition is a statement rather than a plain dataset read. Naming three of §4.16.1's own rows is not seeding them and is not a fourth register: no code is invented, and a code §4.16.1 does not carry cannot be added to the map. `DatasetId` members (§4.16.2) — the twenty-six: `ledger_entry`, `account_balance`, `account`, `document`, `document_line`, `document_event`, `audit_log`, `party`, `party_ageing`, `allocation`, `payment_term`, `bank_statement_line`, `bank_match`, `pdc` ⚠️, `item`, `lot`, `warehouse`, `price_list_line`, `promotion`, `inventory_movement`, `stock_on_hand`, `cost_layer`, `cost_consumption`, `stock_valuation`, `item_profitability`, `tax_transaction`. `fixtures.ts` helpers (§4.17) — **`seedReportDefinition`** and no other. Shared test helpers (§4.17.1) — **none added**; this slice consumes `pdfText`, `postJournal`, `grantAdmin`, `problemOf`, `sharedDb`, `thinRegression`, `sourceFiles`, `repoFile` and `startWorker` as they stand.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-07.

---

## Global Constraints

Every task's requirements implicitly include this section. The values are copied verbatim from the spec and the contracts document.

**The never list (spec:97–104, contracts §3.3).** Never write to a ledger or movement table outside the posting service — **this slice writes none at all**; never represent money as a float, anywhere, including in TypeScript; never build SQL by string concatenation (LEGACY-036/037/069); never issue DDL from application code (LEGACY-053); never disable an invariant, constraint or trigger "temporarily"; never gate an audit write on any flag; never hard-code a package version into a source file — the lockfile owns versions.

**The always list for every new table (spec:106, contracts §3.3, §3.5.1).** `tenant_id uuid not null references app.tenant(id)`; `id uuid primary key default uuidv7()`; `created_at timestamptz not null default now()`; `unique (tenant_id, id)`; composite `(tenant_id, <parent>_id)` foreign keys to every tenant-scoped parent; `call app_meta.enable_tenant_rls('app.<name>')` (which enables **and forces** RLS and creates the policy named exactly `tenant_isolation`); `call app_meta.attach_audit('app.<name>')` unless the table is in `AUDIT_EXEMPT`; `call app_meta.attach_stamp('app.<name>', '<col>_by')` for every `*_by` column; a migration with a hand-written down; a test that a second tenant cannot see it.

**Naming and types (spec:2037–2049).** `snake_case`, **singular** table names; `uuidv7()` server-side for every identifier; all timestamps `timestamptz` in UTC; `effective_date` is a `date`, the accounting date, never derived from `posted_at`; money `numeric(19,4)`, rates `numeric(19,8)`, quantities `numeric(19,6)`; bilingual labels as `name_en` / `name_ar` columns, never a JSON blob; master data is archived with `archived_at`, **never** `DELETE`.

**`*_by` means "the acting principal, stamped by the server" and nothing else (contracts §3.3).** A column recording whom something is *attributed* to is never named `*_by` — hence `saved_view.owner_principal_id`, not `saved_view.owned_by`.

**Database access (spec:2053).** Every query — reads included — runs inside `withTenant(tx => …)`. The `no-bare-db` lint forbids bare `db.` calls; only a `tx` obtained from `withTenant` may tag SQL. The allow-list is fixed (contracts §3.7.5) and **this slice adds nothing to it**.

**`sql.unsafe` has exactly three homes** (contracts §3.3): the migration runner, the pg-boss transactional-enqueue adapter, the importer's Firebird reader. Nothing in this slice uses it.

**Deletion (spec:2049).** `app_rw`'s DELETE grants are the pinned five-row list of contracts §3.5.4 and **2B is the only slice that extends it**. This slice adds no grant and **does not touch `packages/db/test/privileges.test.ts`** beyond re-asserting the unchanged list. `saved_view` and `report_definition` archive with `archived_at`; `report_run` rows are never removed.

**Migrations (spec:2057, contracts §3.4).** One migration per PR; file names match `/^(\d{4})_([a-z0-9_]+)\.sql$/`; each file runs whole in one transaction, so no `create index concurrently`; every object the up creates has a drop in the down in reverse dependency order; every statement carries a comment naming the LEGACY- or spec- reference it serves; SQL keywords lowercase; section banners `-- ── N. title ───`. A slice writes only inside its range (0074–0076) and never asserts `max(version)` — Phase 8 may have applied 0080+ already.

**Per-tenant rows cannot be written by a migration** (contracts §3.4.8, hazard 10). `FORCE ROW LEVEL SECURITY` binds `app_migrator`, so a migration file sees no tenants. `report_definition` and `saved_view` rows are **seed-pack data** applied by `bun run seed --tenant <id> --only reports`. Only `app.permission` (global) is migration data.

**Errors (spec:2051).** Every error carries a stable `ERR_<DOMAIN>_<REASON>` code, a human message naming the specific entity, and a remedy. `ERRORS` in `packages/contracts/src/errors.ts` gains a row in the same PR that raises it; `scripts/lint/rules/error-codes.ts` fails the build on a code with no raiser. This slice adds exactly one row: **`ERR_REPORT_DATASET_UNKNOWN`** (422), already allocated to the report engine in contracts §4.2.4.

**The dependency rule (spec:2389, contracts §3.1).** `packages/domain` imports nothing internal. `packages/db` and `packages/contracts` import `@dulja/domain` **only** — `packages/db` may not import `@dulja/contracts`, which is why this slice ships `ReportError` in `packages/db/src/reports/errors.ts` on the `PostingError` precedent (§4.2.4) instead of `AppError`. `apps/api`, `apps/worker`, `apps/pos`, `apps/backoffice` import from packages, **never from each other** — which is why the worker's PDF adapters are its own and do not import `apps/api`'s `engineFor` (ADR 0066 records the forced duplication). `packages/domain/src/**` may not import `packages/domain/payroll/**`.

**Localisation (spec:2061, spec:2253).** Every user-facing string goes through an ICU message; both catalogues complete before merge. Every generated PDF renders correctly in Arabic and English including numerals, Hijri and Gregorian dates and column order (test 23). The numeral and calendar policy is **0E's** (`@dulja/i18n`'s `FormatContext`, `formatDate`, `formatNumber`, `formatMoney`, `formatQuantity`); `renderReport` takes an injected `ReportFormatters` and never re-decides it.

**Jobs (contracts §4.2.6, hazard 20).** Every handler runs as the tenant's **system principal** through `systemContext`, in many short `withTenant` transactions, never one long one; every job payload carries `tenantId` and is probed by the isolation harness. `JOBS` is closed at sixteen names — `reporting.render` is already in it, owner `7A`, `schedule: null`.

**Routes (spec:2055, contracts §4.2.7, hazard 31).** `/v1/…`; cursor pagination; `Idempotency-Key` required on POST/PUT/PATCH/DELETE; `application/problem+json` errors; OpenAPI generated from Zod, committed, diffed in CI. Every route module needs a `PROBES` entry keyed by its exact `RouteModule.path`, or `tests/invariants/tenant-isolation.test.ts` fails the build. A module is registered **inside `buildRoutes`**, never by pushing onto `ROUTES`.

**The PDF engine is decided once, in 0E (ADR 0016)** (hazard 30). 2C, 7A and 8D consume that ADR and never re-evaluate engines. ADR 0016's Verdict table fixes the closed set `typst | chromium | react-pdf`; `react-pdf` renders a React component, not template text, so it has no adapter (2C's ADR 0032) and `ERR_PRINT_ENGINE_UNSUPPORTED` is what names that.

**No literal in a shared namespace** (hazard 32). Five namespaces are registered in the contracts document: document-type codes (§4.14), account codes (§4.15), report codes and `DatasetId` (§4.16), `fixtures.ts` helpers (§4.17), the `ERR_*` space (§4.2.4). A literal outside them is a review-blocking finding.

**Commits (contracts §3.8).** Conventional commits, subject `<type>(<scope>): <summary> [7A T<n>]`, every commit ending with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` must be green at the end of every task. Pushing to GitHub is the owner's call and is not part of any task's definition of done.

**This slice does not rewrite `AGENTS.md`'s "Current phase" section.** §3.8 assigns that rewrite to the slice that *completes* a phase — 7C for Phase 7. 7A touches no line of it.

---

## Definition of done for this slice

| Clause | Source | Task | Evidence |
|---|---|---|---|
| A user clones and edits a report **without a release** | spec:2293 Phase 7 DoD; §2.8 card | 13 | `apps/api/test/routes/accounting/report-definitions.test.ts` — clone a core definition, edit the clone's columns, run it, and assert the core row is byte-unchanged |
| `ReportDefinition` is text-defined, diffable and version-controlled | spec:1240, spec:1246 (no Delphi-serialised blobs) | 4, 14 | `packages/domain/test/reports/definition.test.ts`; `tests/regression/legacy-077.test.ts` |
| A definition never contributes SQL text | test 27; §2.8 card | 5, 6, 7, 14 | `packages/db/test/reports/datasets.test.ts`; `tests/regression/legacy-069.test.ts`'s 7A block; `bun run lint:rules` |
| An unknown dataset id is `ERR_REPORT_DATASET_UNKNOWN` | §4.11.1, §4.2.4 | 5 | `packages/db/test/reports/datasets.test.ts` |
| Server-side render produces PDF, XLSX and CSV with a status resource | spec:2206, §4.11.2 | 10, 11, 12 | `apps/worker/test/reports/render.test.ts`; `apps/api/test/routes/accounting/report-runs.test.ts` |
| RTL/LTR parity including numerals, Hijri/Gregorian and column order | spec:2253, test 23 | 8, 10, 14 | `apps/worker/test/reports/pdf.test.ts` through `pdfText`; `tests/regression/legacy-085.test.ts`'s 7A block |
| Saved views archive, never delete | spec:2049, §4.11.2, hazard 25 | 2, 13 | `packages/db/test/reports/saved-view.test.ts`; `packages/db/test/privileges.test.ts` re-asserted unchanged |
| Financial-statement layouts: balance sheet and P&L, per BRANCH | spec:1066, §2.8 card | 9 | `packages/domain/test/reports/statement.test.ts`; `packages/db/test/reports/statement-tie-out.test.ts` |
| `accounting.report.export` enters the catalogue with its role grant | §3.6.2, spec:2163 | 3 | `packages/db/test/permission-catalogue.test.ts`; `packages/db/test/roles-seed.test.ts` (the auditor grant, beside 1A's role `it`s); `apps/api/test/reports/authorise.test.ts`; `bun run lint:rules` (`role-seed`, `permission-catalogue`) |
| A second tenant cannot see any new table | spec:106 | 1, 2 | the two-tenant `it` in each table's test file |
| The shipped schema reports zero linter violations | §3.5.2 | 1, 2 | `lintSchema` assertions; `bun run --cwd packages/db db:lint` |

---

## File Structure

Every path is repository-relative. `NEW` files are created by this slice; `EDIT` files are modified additively. The right-hand column is the task number.

```
packages/db/migrations/
├─ 0074_create_report_definition.sql            NEW  app.report_definition                              T1
├─ 0074.down.sql                                NEW                                                     T1
├─ 0075_create_saved_view_report_run.sql        NEW  app.saved_view + app.report_run                     T2
├─ 0075.down.sql                                NEW                                                     T2
├─ 0076_seed_permission_phase7a.sql             NEW  accounting.report.export                            T3
└─ 0076.down.sql                                NEW                                                     T3

packages/db/src/schema/
├─ report-definition.ts                         NEW  Drizzle mirror (§3.4.9)                             T1
├─ saved-view.ts                                NEW  Drizzle mirror                                      T2
└─ report-run.ts                                NEW  Drizzle mirror                                      T2

packages/db/src/reports/
├─ sql-fragment.ts                              NEW  SqlFragment — the postgres.js fragment type          T5
├─ errors.ts                                    NEW  ReportError, ReportErrorCode                         T5
├─ query.ts                                     NEW  defineDataset, datasetWhere, datasetOrderBy          T5
├─ datasets.ts                                  NEW  DatasetId, DATASETS, datasetFor — the closed registry T5,T6,T7
├─ datasets/accounting.ts                       NEW  8 datasets                                           T5
├─ datasets/ar-ap.ts                            NEW  7 datasets                                           T6
├─ datasets/inventory.ts                        NEW  11 datasets                                          T7
├─ definition-store.ts                          NEW  report_definition CRUD, clone, archive              T13
├─ saved-view-store.ts                          NEW  saved_view CRUD, archive                            T13
├─ run-store.ts                                 NEW  report_run lifecycle + reportObjectKeyFor           T11
├─ statement.ts                                 NEW  statementRows + rowsForDefinition + assertDefinitionFields T9
├─ trial-balance.ts                             EDIT unchanged; consumed only (1B)                       T9
└─ index.ts                                     NEW  the barrel re-exported from @dulja/db          T5→T13

packages/db/src/seed/
├─ reports.ts                                   NEW  loadReportDefinitions + reportsLoader               T14
├─ types.ts                                     EDIT SubPack / SUB_PACKS gain "reports"                  T14
├─ packs.ts                                     EDIT PHASE_0_SUB_PACK_DIRECTORIES / OWNED_ELSEWHERE      T14
└─ index.ts                                     EDIT LOADERS + runLoaders' applied initialiser           T14

packages/db/src/index.ts                        EDIT re-exports ./reports                                 T5
packages/db/seed/my/reports/README.md           NEW  the per-slice directory rule                        T14

packages/db/test/
├─ reports/report-definition.test.ts            NEW  DDL, RLS, audit, two-tenant, version uniqueness      T1
├─ reports/saved-view.test.ts                   NEW  DDL, RLS, audit, archive-not-delete, two-tenant      T2
├─ reports/report-run.test.ts                   NEW  DDL, RLS, audit, stamp, CHECKs, two-tenant           T2
├─ reports/datasets.test.ts                     NEW  the registry, filters, unknown id, no SQL text  T5,T6,T7
├─ reports/definition-store.test.ts             NEW  create / clone / update / archive under RLS         T13
├─ reports/saved-view-store.test.ts             NEW  create / list / archive                             T13
├─ reports/run-store.test.ts                    NEW  the lifecycle and the object key                    T11
├─ reports/statement-tie-out.test.ts            NEW  P&L and balance sheet tie to account_balance         T9
├─ seed/reports.test.ts                         NEW  the loader, idempotence, is_core guard              T14
├─ seed-packs.test.ts                           EDIT SUB_PACKS / assertPackShape expectations            T14
├─ permission-catalogue.test.ts                 EDIT + the accounting.report.export it                    T3
├─ roles-seed.test.ts                           EDIT + the auditor-holds-export it (0D's file, 1A's spot) T3
├─ privileges.test.ts                           EDIT the DELETE list re-asserted unchanged after 0075     T2
└─ fixtures.ts                                  EDIT + seedReportDefinition (§4.17)                       T1

packages/domain/
├─ report-definition.schema.json                NEW  $id urn:dulja:report-definition:1                    T4
├─ scripts/generate-report-type.ts              NEW  json-schema-to-typescript, run by report:types       T4
├─ scripts/policy-type-options.ts               EDIT + REPORT_TYPE_OPTIONS beside POLICY_TYPE_OPTIONS     T4
├─ src/reports/
│  ├─ definition.ts                             NEW  ReportDefinition (GENERATED)                          T4
│  ├─ error.ts                                  NEW  ReportDefinitionError — imported by BOTH below         T4
│  ├─ codes.ts                                  NEW  ReportCode, REPORT_CODE_PATTERN, isReportCode         T4
│  ├─ validate.ts                               NEW  validateReportDefinition, parseReportDefinition       T4
│  ├─ format.ts                                 NEW  ReportFormatters, intlFormatters                      T8
│  ├─ render.ts                                 NEW  renderReport, RenderedReport, renderCsv               T8
│  ├─ pdf-source.ts                             NEW  reportToHtmlSource, reportToTypstSource              T10
│  ├─ statement.ts                              NEW  STATEMENT_LAYOUTS + STATEMENT_CODES + statementLayout   T9
│  └─ index.ts                                  NEW  the barrel                                        T4→T10
├─ src/index.ts                                 EDIT export * from "./reports"                             T4
├─ package.json                                 EDIT + the report:types script and two devDependencies     T4
└─ test/reports/
   ├─ definition.test.ts                        NEW  the schema, the grammar, the two closed sets           T4
   ├─ report-type.test.ts                       NEW  the committed type matches the schema                  T4
   ├─ render.test.ts                            NEW  groups, subtotals, totals, sort, both directions        T8
   ├─ render.property.test.ts                   NEW  fast-check: Σ subtotals = total                         T8
   ├─ statement.test.ts                         NEW  assets = liabilities + equity; income − expense          T9
   ├─ pdf-source.test.ts                        NEW  deterministic source text, dir and paper                T10
   └─ fixture/statement-rows.json               NEW  the golden chart-of-accounts balances                    T9

packages/contracts/src/
├─ errors.ts                                    EDIT + ERR_REPORT_DATASET_UNKNOWN                           T5
├─ accounting/report-definition.ts              NEW  ReportDefinitionSchema, CreateReportDefinitionBody, …  T13
├─ accounting/saved-view.ts                     NEW  SavedViewSchema, CreateSavedViewBody, …                T13
├─ accounting/report-run.ts                     NEW  ReportRunSchema, CreateReportRunBody, …                T12
└─ index.ts                                     EDIT re-exports the three new modules                      T12,T13

packages/contracts/                             (NOT under src/ — §3.6.1 and §4.2.5 fix both paths)
├─ permissions.ts                               EDIT + accounting.report.export                              T3
└─ test/report-filter-ops.test.ts               NEW  FILTER_OPS === REPORT_FILTER_OPS, both directions        T4

packages/db/seed/roles.ts                       EDIT auditor gains accounting.report.export                  T3

apps/worker/src/
├─ object-store.ts                              NEW  objectStore(), setObjectStore()                        T10
├─ reports/
│  ├─ formatters.ts                             NEW  i18nFormatters — the @dulja/i18n adapter               T10
│  ├─ renderers/index.ts                        NEW  ReportRenderer, REPORT_RENDERERS, rendererFor          T10
│  ├─ renderers/csv.ts                          NEW  the CSV renderer                                       T10
│  ├─ renderers/xlsx.ts                         NEW  the ExcelJS renderer                                   T10
│  ├─ renderers/pdf.ts                          NEW  the PDF renderer over an ADR-0016 engine               T10
│  ├─ engines/index.ts                          NEW  ReportPdfEngine, REPORT_PDF_ENGINES, reportPdfEngine   T10
│  ├─ engines/typst.ts                          NEW  the typst-binary adapter                               T10
│  └─ engines/chromium.ts                       NEW  the Playwright adapter                                 T10
├─ jobs/report-render.ts                        NEW  the reporting.render handler                           T11
├─ index.ts                                     EDIT registerHandler("reporting.render", …)                 T11
├─ package.json                                 EDIT + exceljs, playwright, @dulja/i18n                      T10
└─ tsconfig.json                                EDIT + the tests/ include the shared-helper import needs     T10

apps/worker/test/
├─ support/worker.ts                            EDIT registers the reporting.render handler                 T11
├─ reports/renderers.test.ts                    NEW  CSV and XLSX bytes                                     T10
├─ reports/pdf.test.ts                          NEW  test 23 re-run through pdfText                         T10
└─ reports/render.test.ts                       NEW  the handler drives a run queued → done                 T11

apps/api/src/
├─ problem.ts                                   EDIT one asAppError branch for ReportError                  T5
├─ routes/accounting/reports.ts                 EDIT + POST …/reports/{code}/runs (1B's module)             T12
├─ routes/accounting/report-definitions.ts      NEW  reportDefinitionRoutes                                 T13
├─ routes/accounting/saved-views.ts             NEW  savedViewRoutes                                        T13
├─ routes/accounting/report-runs.ts             NEW  reportRunRoutes                                        T12
├─ routes/index.ts                              EDIT three RouteModule registrations in buildRoutes    T12,T13
├─ reports/authorise.ts                         NEW  requireReportExport (T3); T12 APPENDS the other three T3,T12
├─ tsconfig.json                                EDIT + the tests/ include the shared-helper import needs     T10
└─ object-store.ts                              EDIT unchanged; consumed only                               T12

apps/api/test/
└─ reports/authorise.test.ts                    NEW  requireReportExport allows / refuses                    T3

apps/api/test/routes/accounting/
├─ report-definitions.test.ts                   NEW  the clone-and-edit DoD                                 T13
├─ saved-views.test.ts                          NEW  create, list, share, archive                           T13
├─ report-runs.test.ts                          NEW  the 202, the status resource, the content download     T12
└─ reports.test.ts                              EDIT + the runs sub-path                                    T12

apps/backoffice/src/                            (Task 15 — BLOCKED on OD-24; no file is created until then)

scripts/lint/rules/
└─ dependency-rule.ts                           EDIT + the TEST_TIER_SHARED allowance for tests/support/**   T10

infra/
├─ secrets.ts                                   EDIT containerSecrets(env, "worker") gains the four R2 names T10
└─ test/secrets.test.ts                         EDIT the worker environment expectation                      T10

tests/
├─ invariants/probes.ts                         EDIT three PROBES entries + the runs sub-path      T11,T12,T13
└─ regression/
   ├─ legacy-077.test.ts                           NEW  report definitions as version-controlled text            T14
   ├─ legacy-069.test.ts                           EDIT + the 7A block (static SQL only)                          T14
   └─ legacy-085.test.ts                           EDIT + the 7A block (both catalogues in every PDF)             T14

docs/adr/
├─ 0065-report-definition-format.md             NEW                                                          T4
├─ 0066-server-side-report-render.md            NEW                                                         T10
└─ 0067-saved-views-and-report-runs.md          NEW                                                          T2
```

**Two structural notes an implementer needs before Task 1.**

**`packages/db/src/reports/` already exists** — 1B created it with `trial-balance.ts` and `ledger.ts` (§4.16.3). This slice adds files beside them and **never edits either**: `trialBalance`, `trialBalanceFingerprint`, `accountLedger` and `accountOpeningBalance` keep their signatures, because 7B re-expresses 1B's two reports over exactly those functions and 1B's tie-out test is the proof nothing moved. `packages/db/src/reports/index.ts` is new: 1B exported its two modules directly from `packages/db/src/index.ts`, and this slice adds a barrel for its own files rather than lengthening that list twenty times.

**`lint-schema.ts` is not edited by this slice.** Contracts §3.5.3 gives `report_definition`, `saved_view` and `report_run` **no** set membership — not `NO_ID_TABLES`, not `NO_CREATED_AT_TABLES`, not `AUDIT_EXEMPT`, not `IMMUTABLE` — so all three carry `id`, `created_at` and an `audit_row` trigger, and the six sets stay exactly as 5A left them. None of the three has a `branch_id` or `home_branch_id` column and none is one of the five stock tables of §4.5.6 Form C, so none receives a `branch_isolation` policy and `branch_isolation_policy` (6C's rule) has nothing to say about them. If a task in this plan finds itself editing `packages/db/src/lint-schema.ts`, it has gone wrong — stop and re-read §3.5.3.

---

### Task 1: `app.report_definition` — migration 0074, the Drizzle mirror, and `seedReportDefinition`

§4.11.2 fixes the table: `report_definition(company_id, code, version int, definition jsonb not null /* validated */, cloned_from uuid, is_core boolean not null default false, archived_at; unique (company_id, code, version))`. This task ships that DDL with the standard set of §3.5.1, the Drizzle mirror §3.4.9 requires in the same PR, and the one `fixtures.ts` helper §4.17 assigns this slice.

**Files:**
- Create: `packages/db/migrations/0074_create_report_definition.sql`, `packages/db/migrations/0074.down.sql`, `packages/db/src/schema/report-definition.ts`, `packages/db/test/reports/report-definition.test.ts`
- Modify: `packages/db/test/fixtures.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant` (the 4-argument **test** helper), `uuidv7`, `Seed` from `packages/db/test/harness.ts` and `packages/db/test/fixtures.ts` (§4.1); `seedTenantV2` (§4.17, 1A); `lintSchema`, `Violation` from `@dulja/db` (§4.1); `app_meta.enable_tenant_rls`, `app_meta.attach_audit` (§4.1).
- Produces:

```ts
// packages/db/src/schema/report-definition.ts
export const reportDefinition: PgTable;      // Drizzle mirror of app.report_definition — reads only (§3.4.9)

// packages/db/test/fixtures.ts — §4.17's one row for this slice
export interface SeedReportDefinitionOptions {
  code: string;
  definition: unknown;
  /** `app.report_definition.version` — the tenant-edit/row version, NOT `ReportDefinition.version`, which is
   *  the frozen FORMAT version `1` of §4.11.1. The two are different numbers and the names must not collide,
   *  which is why this option is `definitionVersion` and never `version` (Task 14 applies the same rule to the
   *  seed-file envelope). Defaults to 1. */
  definitionVersion?: number;
  isCore?: boolean;          // default true — a seeded core definition is what a clone test clones
  clonedFrom?: string | null;
}
export function seedReportDefinition(db: Db, s: Seed, opts: SeedReportDefinitionOptions): Promise<string>;   // the row id
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/reports/report-definition.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("app.report_definition — contracts §4.11.2, spec:1240 (text-defined, diffable, version-controlled)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "report-def-a");
    b = await seedTenantV2(db, "report-def-b");
  });
  afterAll(async () => { await db.stop(); });

  const DEF = {
    version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
    module: "accounting", permission: "accounting.report.read", parameters: [],
    dataset: { source: "account_balance", filters: [] },
    columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
    groups: [], totals: [], sort: [{ field: "account_code", dir: "asc" }],
    layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
    tieOut: { kind: "none" },
  };

  it("carries every column §4.11.2 names, at the declared types", async () => {
    const cols = await db.migrator<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'app' and table_name = 'report_definition'
       order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "archived_at", "cloned_from", "code", "company_id", "created_at",
      "definition", "id", "is_core", "tenant_id", "version",
    ]);
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect(byName.get("definition")!.data_type).toBe("jsonb");
    expect(byName.get("definition")!.is_nullable).toBe("NO");
    expect(byName.get("version")!.data_type).toBe("integer");
    expect(byName.get("is_core")!.is_nullable).toBe("NO");
    expect(byName.get("archived_at")!.is_nullable).toBe("YES");
  });

  it("is unique on (company_id, code, version) and refuses version 0", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
               values (${a.tenant}, ${a.company}, 'accounting.ledger', 1, ${JSON.stringify(DEF)}::jsonb)`;
      await expect(
        tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
           values (${a.tenant}, ${a.company}, 'accounting.ledger', 1, ${JSON.stringify(DEF)}::jsonb)`,
      ).rejects.toMatchObject({ code: "23505" });
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
           values (${a.tenant}, ${a.company}, 'accounting.ledger', 0, ${JSON.stringify(DEF)}::jsonb)`,
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("writes an audit row on insert and on update (spec:106; no AUDIT_EXEMPT membership — §3.5.3)", async () => {
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.report_definition (tenant_id, company_id, code, version, definition)
        values (${a.tenant}, ${a.company}, 'inventory.stock_on_hand', 1, ${JSON.stringify(DEF)}::jsonb)
        returning id`;
      await tx`update app.report_definition set archived_at = now() where id = ${row!.id}`;
      return row!.id;
    });
    const rows = await db.migrator<{ action: string }[]>`
      select action from app.audit_log
       where table_name = 'report_definition' and row_id = ${id} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert", "update"]);
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
               values (${a.tenant}, ${a.company}, 'accounting.general_ledger', 1, ${JSON.stringify(DEF)}::jsonb)`;
    });
    const seen = await withTenant(db.rw, b.tenant, b.human, async (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.report_definition`);
    expect(seen[0]!.n).toBe(0);
  });

  it("refuses a cross-tenant company_id through the composite FK", async () => {
    const bogus = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
           values (${a.tenant}, ${b.company}, 'accounting.journal_register', 1, ${JSON.stringify(DEF)}::jsonb)`,
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        tx`insert into app.report_definition (tenant_id, company_id, code, version, definition, cloned_from)
           values (${a.tenant}, ${a.company}, 'accounting.account_statement', 1, ${JSON.stringify(DEF)}::jsonb, ${bogus})`,
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("reports zero linter violations (§3.5.2)", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v: { table: string }) => v.table === "report_definition")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- reports/report-definition`
Expected: FAIL — the first `it` returns an empty column list (`[]` does not equal the ten names), because `app.report_definition` does not exist.

- [ ] **Step 3: Edit the Drizzle mirror and generate the up file**

`packages/db/src/schema/report-definition.ts`:

```ts
import { boolean, integer, jsonb, pgSchema, timestamp, uuid, text, unique, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const app = pgSchema("app");

/** Read mirror of app.report_definition (§3.4.9, ADR-0002). Writes go through packages/db/src/reports/. */
export const reportDefinition = app.table("report_definition", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  code: text("code").notNull(),
  version: integer("version").notNull(),
  definition: jsonb("definition").notNull(),
  clonedFrom: uuid("cloned_from"),
  isCore: boolean("is_core").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("report_definition_company_id_code_version_key").on(t.companyId, t.code, t.version),
  unique("report_definition_tenant_id_id_key").on(t.tenantId, t.id),
  check("report_definition_version_check", sql`${t.version} > 0`),
]);
```

Then run `bun run --cwd packages/db exec drizzle-kit generate`, rename its output into this slice's range and hand-edit it — the generator emits no `app_meta` procedure calls, no comments and no composite foreign keys, so hand-editing is the norm (§3.4.9).

`packages/db/migrations/0074_create_report_definition.sql`:

```sql
-- ── 0074. app.report_definition — the report builder's stored definition ───────
-- contracts §4.11.2. spec:1240 wants an end-user report designer that is "text-defined, diffable,
-- version-controlled"; spec:1246 puts "Delphi-serialised report files" on the explicit do-NOT-carry-over
-- list and LEGACY-077 is the defect that follows from them (report definitions as MEMO blobs in customer
-- databases, so no static analysis can ever tell whether a procedure is live). A definition here is
-- validated JSON seeded from a version-controlled file, and a tenant's edit is a NEW version row.

-- ── 1. the table ──────────────────────────────────────────────────────────────
create table app.report_definition (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  code         text not null,                                  -- the §4.16.1 register; grammar checked in TypeScript
  version      int  not null,                                  -- a tenant edit is a new version, never an in-place rewrite
  definition   jsonb not null,                                 -- validated against packages/domain/report-definition.schema.json
  cloned_from  uuid,                                           -- the row this one was cloned from (the DoD's clone-and-edit)
  is_core      boolean not null default false,                 -- true = seeded from the pack; false = a tenant's own
  archived_at  timestamptz,                                    -- archived, never deleted (spec:2049)
  created_at   timestamptz not null default now(),
  constraint report_definition_version_check check (version > 0),   -- 2C's precedent on print_template.version (§4.5.9)
  constraint report_definition_company_id_code_version_key unique (company_id, code, version),
  constraint report_definition_tenant_id_id_key unique (tenant_id, id),
  -- Composite FKs: an FK check bypasses RLS, so a plain references app.company(id) would let tenant A's
  -- definition point at tenant B's company if the uuid were known (§3.5.1).
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, cloned_from) references app.report_definition(tenant_id, id)
);

-- ── 2. the index the definition list and the run route filter on ──────────────
-- LEGACY-070: index coverage was thin on exactly the columns reports filter by. Every read of this table is
-- "the live definitions of this company for this code", so the index carries all three and excludes archived rows.
create index report_definition_lookup_idx on app.report_definition (company_id, code, version desc)
  where archived_at is null;

-- ── 3. tenancy, audit ─────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.report_definition');   -- enables AND forces RLS; policy named tenant_isolation
call app_meta.attach_audit('app.report_definition');        -- §3.5.3 grants this table no AUDIT_EXEMPT membership
-- app_rw receives select, insert, update through app_migrator's default privileges (plan0A:2564) — no grant
-- statement here. No DELETE: §3.5.4's pinned list is unchanged by this slice, and archival is archived_at.
```

`packages/db/migrations/0074.down.sql`:

```sql
-- Reverse dependency order (§3.4.5). drop function … cascade is the accepted way to remove a function's
-- triggers (plan0A:1518); here the audit trigger goes with the table, so only the table is dropped.
drop index if exists app.report_definition_lookup_idx;
drop table if exists app.report_definition;
```

- [ ] **Step 4: Apply the migration and run the test to see it pass**

Run: `bun run --cwd packages/db test -- reports/report-definition`
Expected: PASS — all six `it`s. `startDb()` applies every migration in version order before the first `beforeAll` returns.

- [ ] **Step 5: Prove the down file is exact**

Run: `bun run --cwd packages/db test -- privileges`
Expected: PASS — 0B's generalised reversibility test (§3.4.6) applies `down` to 0, asserts zero tables in schema `app`, re-applies `up`, and compares `schemaFingerprint` byte for byte. A missing `drop index` or a forgotten constraint shows here as a fingerprint difference.

- [ ] **Step 6: Add `seedReportDefinition` to `packages/db/test/fixtures.ts`**

Append — never edit an existing helper or constant (§4.1, hazard 9). **§4.17 registers this helper for 7A as
`seedReportDefinition(db, s, opts: { code; definition })`, and the three options below are additive**, which
§4.17's own rule permits — "a slice needing an option a listed one lacks adds the option additively (never
changes an existing parameter or return) and records it here in the same PR." So the §4.17 row amendment in
the Execution-handoff table is landed **in this PR**, not later: `{ code; definition; definitionVersion?;
isCore?; clonedFrom? }` returning the row's `id`.

```ts
/**
 * §4.17's one row for slice 7A. `isCore` defaults to true because the clone-and-edit tests (Task 13) need a
 * core row to clone; a tenant's own definition is what `cloneReportDefinition` produces, not what a fixture seeds.
 */
export interface SeedReportDefinitionOptions {
  code: string;
  definition: unknown;
  /** the ROW version (`app.report_definition.version`), never `ReportDefinition.version` — see the Produces block */
  definitionVersion?: number;
  isCore?: boolean;
  clonedFrom?: string | null;
}

export async function seedReportDefinition(
  db: Db,
  s: Seed,
  opts: SeedReportDefinitionOptions,
): Promise<string> {
  return withTenant(db.rw, s.tenant, s.human, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into app.report_definition (tenant_id, company_id, code, version, definition, is_core, cloned_from)
      values (${s.tenant}, ${s.company}, ${opts.code}, ${opts.definitionVersion ?? 1},
              ${JSON.stringify(opts.definition)}::jsonb, ${opts.isCore ?? true}, ${opts.clonedFrom ?? null})
      returning id`;
    return row!.id;
  });
}
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/migrations/0074_create_report_definition.sql packages/db/migrations/0074.down.sql \
        packages/db/src/schema/report-definition.ts packages/db/test/reports/report-definition.test.ts \
        packages/db/test/fixtures.ts
git commit -m "$(cat <<'EOF'
feat(db): add app.report_definition and seedReportDefinition [7A T1]

Migration 0074 with the §4.11.2 columns, the (company_id, code, version) key,
version > 0, the composite FKs, forced RLS and the audit trigger. §3.5.3 gives
the table no linter-set membership, so lint-schema.ts is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `app.saved_view` and `app.report_run` — migration 0075, the mirrors, and ADR 0067

§4.11.2 fixes both tables and one behavioural rule that governs them: a saved view is **archived, never deleted**, because spec:2049 admits genuine deletion only "for drafts and for the GDPR/PDPA erasure workflow" and a saved view is neither. So this task adds **no** DELETE grant, leaves §3.5.4's pinned five-row list alone, and re-asserts it in `privileges.test.ts` so the fact is proven rather than assumed (hazard 25).

**Files:**
- Create: `packages/db/migrations/0075_create_saved_view_report_run.sql`, `packages/db/migrations/0075.down.sql`, `packages/db/src/schema/saved-view.ts`, `packages/db/src/schema/report-run.ts`, `packages/db/test/reports/saved-view.test.ts`, `packages/db/test/reports/report-run.test.ts`, `docs/adr/0067-saved-views-and-report-runs.md`
- Modify: `packages/db/test/privileges.test.ts`

**Interfaces:**
- Consumes: `startDb`, `Db`, `withTenant` (test), `uuidv7`, `Seed`, `seedTenantV2`, `seedReportDefinition` (Task 1); `lintSchema` (§4.1); `app_meta.enable_tenant_rls`, `app_meta.attach_audit`, `app_meta.attach_stamp` (§4.1).
- Produces:

```ts
// packages/db/src/schema/saved-view.ts
export const savedView: PgTable;
// packages/db/src/schema/report-run.ts
export const reportRun: PgTable;
```

- [ ] **Step 1: Write the failing tests**

`packages/db/test/reports/saved-view.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DEF = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read", parameters: [],
  dataset: { source: "account_balance", filters: [] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("app.saved_view — contracts §4.11.2; archived, never deleted (spec:2049, hazard 25)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let definitionId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "saved-view-a");
    b = await seedTenantV2(db, "saved-view-b");
    definitionId = await seedReportDefinition(db, a, { code: "accounting.trial_balance", definition: DEF });
  });
  afterAll(async () => { await db.stop(); });

  it("carries every column §4.11.2 names", async () => {
    const cols = await db.migrator<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'saved_view' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "archived_at", "company_id", "created_at", "id", "name_ar", "name_en",
      "owner_principal_id", "parameters", "report_definition_id", "shared", "tenant_id",
    ]);
  });

  it("defaults owner_principal_id to app.current_actor() and is NOT a *_by column (§3.3)", async () => {
    const [row] = await withTenant(db.rw, a.tenant, a.human, async (tx) =>
      tx<{ owner_principal_id: string }[]>`
        insert into app.saved_view (tenant_id, company_id, report_definition_id, name_en)
        values (${a.tenant}, ${a.company}, ${definitionId}, 'My period')
        returning owner_principal_id`);
    expect(row!.owner_principal_id).toBe(a.human);
    const stamps = await db.migrator<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.saved_view'::regclass and not tgisinternal order by tgname`;
    // owner_principal_id records WHOM the view belongs to, which is data — so it takes the column default and
    // gets no stamp trigger. A *_by spelling would either fail the stamp_actor linter rule or silently replace
    // the owner with whoever last touched the row, which is LEGACY-044 in the opposite direction (§3.3).
    expect(stamps.map((t) => t.tgname)).toEqual(["audit_row"]);
  });

  it("app_rw cannot DELETE — a view is archived (§3.5.4's pinned list is unchanged by 7A)", async () => {
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.saved_view (tenant_id, company_id, report_definition_id, name_en)
        values (${a.tenant}, ${a.company}, ${definitionId}, 'Q1 by branch') returning id`;
      return row!.id;
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(tx`delete from app.saved_view where id = ${id}`).rejects.toMatchObject({ code: "42501" });
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.saved_view set archived_at = now() where id = ${id}`;
      const [still] = await tx<{ n: number }[]>`
        select count(*)::int as n from app.saved_view where id = ${id} and archived_at is not null`;
      expect(still!.n).toBe(1);
    });
  });

  it("a second tenant cannot see it, and cannot point a view at another tenant's definition", async () => {
    const seen = await withTenant(db.rw, b.tenant, b.human, async (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.saved_view`);
    expect(seen[0]!.n).toBe(0);
    await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      await expect(
        tx`insert into app.saved_view (tenant_id, company_id, report_definition_id, name_en)
           values (${b.tenant}, ${b.company}, ${definitionId}, 'stolen')`,
      ).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("reports zero linter violations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v: { table: string }) => v.table === "saved_view")).toEqual([]);
  });
});
```

`packages/db/test/reports/report-run.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DEF = {
  version: 1, code: "accounting.ledger", nameEn: "Ledger", nameAr: "دفتر الأستاذ",
  module: "accounting", permission: "accounting.report.read", parameters: [],
  dataset: { source: "ledger_entry", filters: [] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("app.report_run — contracts §4.11.2; the status resource spec:2206 requires", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let definitionId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "report-run-a");
    b = await seedTenantV2(db, "report-run-b");
    definitionId = await seedReportDefinition(db, a, { code: "accounting.ledger", definition: DEF });
  });
  afterAll(async () => { await db.stop(); });

  it("carries every column §4.11.2 names", async () => {
    const cols = await db.migrator<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'report_run' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "company_id", "created_at", "error", "finished_at", "format", "id", "lang",
      "object_key", "parameters", "report_definition_id", "requested_by", "saved_view_id",
      "sha256", "status", "tenant_id",
    ]);
  });

  it("enforces the three closed vocabularies", async () => {
    for (const [col, bad] of [["format", "docx"], ["lang", "fr"], ["status", "pending"]] as const) {
      await withTenant(db.rw, a.tenant, a.human, async (tx) => {
        const format = col === "format" ? bad : "pdf";
        const lang = col === "lang" ? bad : "en";
        const status = col === "status" ? bad : "queued";
        await expect(
          tx`insert into app.report_run (tenant_id, company_id, report_definition_id, format, lang, status)
             values (${a.tenant}, ${a.company}, ${definitionId}, ${format}, ${lang}, ${status})`,
        ).rejects.toMatchObject({ code: "23514" });
      });
    }
  });

  it("stamps requested_by from the session and refuses to have it re-written (ERR_ACTOR_IMMUTABLE)", async () => {
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string; requested_by: string }[]>`
        insert into app.report_run (tenant_id, company_id, report_definition_id, format, lang, status)
        values (${a.tenant}, ${a.company}, ${definitionId}, 'csv', 'en', 'queued')
        returning id, requested_by`;
      expect(row!.requested_by).toBe(a.human);
      return row!.id;
    });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await expect(
        tx`update app.report_run set requested_by = ${a.system} where id = ${id}`,
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("moves queued → running → done and records the artefact", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.report_run (tenant_id, company_id, report_definition_id, format, lang, status)
        values (${a.tenant}, ${a.company}, ${definitionId}, 'pdf', 'ar', 'queued') returning id`;
      await tx`update app.report_run set status = 'running' where id = ${row!.id}`;
      await tx`update app.report_run
                  set status = 'done', object_key = ${`${a.tenant}/reports/${row!.id}.pdf`},
                      -- `sha256(bytea)` is a PostgreSQL 18 BUILTIN and needs no extension. `digest()` would
                      -- be pgcrypto, which Plan 0A never installs (plan0A:952 creates `btree_gist` only) —
                      -- 4B hit and recorded the same trap.
                      sha256 = sha256('x'::bytea), finished_at = now()
                where id = ${row!.id}`;
      const [done] = await tx<{ status: string; object_key: string }[]>`
        select status, object_key from app.report_run where id = ${row!.id}`;
      expect(done!.status).toBe("done");
      expect(done!.object_key).toBe(`${a.tenant}/reports/${row!.id}.pdf`);
    });
  });

  it("a second tenant cannot see it", async () => {
    const seen = await withTenant(db.rw, b.tenant, b.human, async (tx) =>
      tx<{ n: number }[]>`select count(*)::int as n from app.report_run`);
    expect(seen[0]!.n).toBe(0);
  });

  it("reports zero linter violations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v: { table: string }) => v.table === "report_run")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/db test -- reports/saved-view reports/report-run`
Expected: FAIL — both first `it`s compare `[]` against the column lists, because neither table exists.

- [ ] **Step 3: Write the Drizzle mirrors**

`packages/db/src/schema/saved-view.ts`:

```ts
import { boolean, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const app = pgSchema("app");

export const savedView = app.table("saved_view", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  reportDefinitionId: uuid("report_definition_id").notNull(),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar"),
  parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
  ownerPrincipalId: uuid("owner_principal_id").notNull().default(sql`app.current_actor()`),
  shared: boolean("shared").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("saved_view_tenant_id_id_key").on(t.tenantId, t.id)]);
```

`packages/db/src/schema/report-run.ts`:

```ts
import { char, customType, jsonb, pgSchema, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const app = pgSchema("app");

/** bytea has no first-class Drizzle column; the mirror is read-only, so a Uint8Array custom type is enough. */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value),
});

export const reportRun = app.table("report_run", {
  id: uuid("id").primaryKey().default(sql`uuidv7()`),
  tenantId: uuid("tenant_id").notNull(),
  companyId: uuid("company_id").notNull(),
  reportDefinitionId: uuid("report_definition_id").notNull(),
  savedViewId: uuid("saved_view_id"),
  parameters: jsonb("parameters").notNull().default(sql`'{}'::jsonb`),
  format: text("format").notNull(),
  // `char`, not `text`: the DDL says `char(2)` and ADR 0002 makes this mirror the diff source, so a
  // `text()` here would make `drizzle-kit` report a phantom column change on every run.
  lang: char("lang", { length: 2 }).notNull(),
  status: text("status").notNull().default("queued"),
  requestedBy: uuid("requested_by").notNull().default(sql`app.current_actor()`),
  objectKey: text("object_key"),
  sha256: bytea("sha256"),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("report_run_tenant_id_id_key").on(t.tenantId, t.id)]);
```

- [ ] **Step 4: Write migration 0075 and its down file**

`packages/db/migrations/0075_create_saved_view_report_run.sql`:

```sql
-- ── 0075. app.saved_view and app.report_run ───────────────────────────────────
-- contracts §4.11.2. A saved view is a named parameter set over a definition — spec:1241's "an accountant
-- filters a ledger and wants that exact view back from a bookmark", persisted server-side so the bookmark
-- survives a new machine. A report run is the async status resource spec:2206 requires for a bulk render.

-- ── 1. saved_view — archived, never deleted (spec:2049) ───────────────────────
create table app.saved_view (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  report_definition_id uuid not null,
  name_en              text not null,                          -- bilingual labels as columns, not a blob (spec:2045)
  name_ar              text,
  parameters           jsonb not null default '{}'::jsonb,     -- the definition's parameter names → entered values
  -- owner_principal_id, NOT owner_by: this records WHOM the view belongs to, which is data. A *_by name would
  -- attract app.stamp_actor and silently replace the owner with the acting principal (§3.3, LEGACY-044 inverted).
  owner_principal_id   uuid not null default app.current_actor() references app.principal(id),
  shared               boolean not null default false,         -- visible to every principal of the company
  archived_at          timestamptz,
  created_at           timestamptz not null default now(),
  constraint saved_view_tenant_id_id_key unique (tenant_id, id),
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  foreign key (tenant_id, report_definition_id) references app.report_definition(tenant_id, id)
);
create index saved_view_owner_idx on app.saved_view (company_id, owner_principal_id)
  where archived_at is null;                                   -- LEGACY-070: the column the list filters by
create index saved_view_shared_idx on app.saved_view (company_id, report_definition_id)
  where archived_at is null and shared;

call app_meta.enable_tenant_rls('app.saved_view');
call app_meta.attach_audit('app.saved_view');
-- No DELETE grant. spec:2049 admits genuine deletion only for drafts and the erasure workflow, and a saved
-- view is neither, so §3.5.4's pinned five-row list is unchanged and privileges.test.ts is untouched (hazard 25).

-- ── 2. report_run — the async status resource (spec:2206) ─────────────────────
create table app.report_run (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  report_definition_id uuid not null,
  saved_view_id        uuid,                                   -- null = ad-hoc parameters
  parameters           jsonb not null default '{}'::jsonb,
  format               text not null check (format in ('pdf','xlsx','csv')),
  lang                 char(2) not null check (lang in ('en','ar')),   -- @dulja/i18n's two Locales (0E)
  status               text not null default 'queued' check (status in ('queued','running','done','failed')),
  requested_by         uuid not null default app.current_actor() references app.principal(id),   -- stamped
  object_key           text,                                   -- '<tenant_id>/reports/<run_id>.<ext>' (LEGACY-038: server-generated)
  sha256               bytea,                                  -- of the rendered bytes
  finished_at          timestamptz,
  error                text,                                   -- the problem code and detail on 'failed'
  created_at           timestamptz not null default now(),
  constraint report_run_object_key_key unique (object_key),
  constraint report_run_tenant_id_id_key unique (tenant_id, id),
  -- done implies an artefact; failed implies a reason. Without these a run could report success with nothing
  -- to download, which is the class of defect LEGACY-084 describes on the error side.
  constraint report_run_done_has_artefact check (status <> 'done' or (object_key is not null and sha256 is not null)),
  constraint report_run_failed_has_error  check (status <> 'failed' or error is not null),
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  foreign key (tenant_id, report_definition_id) references app.report_definition(tenant_id, id),
  foreign key (tenant_id, saved_view_id)        references app.saved_view(tenant_id, id)
);
create index report_run_recent_idx on app.report_run (company_id, created_at desc);   -- LEGACY-070: the list's sort key
create index report_run_queued_idx on app.report_run (company_id, status) where status in ('queued','running');

call app_meta.enable_tenant_rls('app.report_run');
call app_meta.attach_audit('app.report_run');
call app_meta.attach_stamp('app.report_run', 'requested_by');   -- every *_by column gets its trigger (§3.5.1 step 4)
```

`packages/db/migrations/0075.down.sql`:

```sql
drop index if exists app.report_run_queued_idx;
drop index if exists app.report_run_recent_idx;
drop table if exists app.report_run;
drop index if exists app.saved_view_shared_idx;
drop index if exists app.saved_view_owner_idx;
drop table if exists app.saved_view;
```

- [ ] **Step 5: Run the two tests to see them pass**

Run: `bun run --cwd packages/db test -- reports/saved-view reports/report-run`
Expected: PASS — eleven `it`s across the two files.

- [ ] **Step 6: Re-assert the unchanged DELETE list in `privileges.test.ts`**

Append one `it` — do not touch the existing pinned list:

```ts
  it("7A adds no DELETE grant: the list after 0075 is still 2B's five (§3.5.4, hazard 25)", async () => {
    const rows = await db.admin<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and privilege_type = 'DELETE'
       order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "document", "document_line", "idempotency_key", "role_assignment_branch", "role_permission",
    ]);
  });
```

Run: `bun run --cwd packages/db test -- privileges`
Expected: PASS — the new `it` and the generalised reversibility test both green.

- [ ] **Step 7: Write ADR 0067**

`docs/adr/0067-saved-views-and-report-runs.md`:

```markdown
# ADR 0067 — Saved views archive; a report run is an immutable artefact record

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 7A
- **Supersedes / superseded by:** —

## Context

spec:1241 wants an end-user report designer with saved views: "an accountant filters a ledger and wants that
exact view back from a bookmark". spec:2049 says master data is archived, never deleted, and admits genuine
deletion only "for drafts and for the GDPR/PDPA erasure workflow". Contracts §3.5.4 pins `app_rw`'s DELETE
grants to five tables and names 2B as the only slice that extends the list. spec:2206 wants bulk endpoints
with "async job semantics and a status resource".

## Decision

1. **`saved_view` is archived with `archived_at`.** `DELETE /v1/companies/{companyId}/saved-views/{id}` sets
   `archived_at` and returns 204. No DELETE grant is added; `privileges.test.ts` re-asserts the unchanged
   five-row list rather than growing it.
2. **`report_run` is the status resource.** A run row is created `queued` inside the same transaction that
   enqueues `reporting.render`, so a rolled-back request leaves neither (spec:2321). The job moves it to
   `running`, then to `done` with `object_key` and `sha256`, or to `failed` with `error`. Two CHECK
   constraints make "done with nothing to download" and "failed with no reason" unrepresentable.
3. **The status URL is the run itself.** §4.11.2's literal `statusUrl: "/v1/jobs/<jobId>"` is replaced by
   `"/v1/companies/<companyId>/report-runs/<runId>"`, because **no slice mounts `/v1/jobs/{jobId}`** — §4.2.7
   lists the path in the URL scheme and assigns it to no module, and 6A already amended §4.10.4 for the same
   reason. Pointing a caller at an unmounted path would be a 404 dressed as a contract. The run resource is
   mounted, gated, probed and carries strictly more information than a pg-boss job id.
4. **A run row is never deleted.** It is the audit trail of who exported what (test 13's clause for 7C's
   exports applies to renders too). Retention is a later operational decision, not a v1 grant.

## Consequences

- A tenant accumulates `report_run` rows. The `report_run_recent_idx` partial-free index keeps the list read
  cheap; pruning, if it is ever wanted, is a job in a later slice and an amendment to §3.5.4, not a grant here.
- `object_key` is `unique`, so two runs can never claim one object and a replayed idempotency key that
  re-inserted a run would fail loudly rather than overwrite an artefact.
```

- [ ] **Step 8: Commit**

```bash
git add packages/db/migrations/0075_create_saved_view_report_run.sql packages/db/migrations/0075.down.sql \
        packages/db/src/schema/saved-view.ts packages/db/src/schema/report-run.ts \
        packages/db/test/reports/saved-view.test.ts packages/db/test/reports/report-run.test.ts \
        packages/db/test/privileges.test.ts docs/adr/0067-saved-views-and-report-runs.md
git commit -m "$(cat <<'EOF'
feat(db): add app.saved_view and app.report_run [7A T2]

Migration 0075. saved_view archives with archived_at and gains no DELETE grant,
so §3.5.4's pinned list is re-asserted unchanged. report_run is the spec:2206
status resource, with CHECKs making "done with no artefact" and "failed with no
reason" unrepresentable. ADR 0067 records the status-URL amendment.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `accounting.report.export` — migration 0076, the catalogue row, and the `auditor` grant

§3.6.2 assigns exactly one permission code to this slice: **`accounting.report.export`**, module `accounting`, `mutating: false`. spec:2163 gives the `auditor` role "Read everything financial: ledger, documents, reports, stock and costs … and export", and R7 (spec:2178) requires CI to prove `auditor` holds no mutating code — which this row satisfies because it is non-mutating. Nothing else in the catalogue moves: `accounting.report.read` is 1B's, `pos.report.read` is 6D's, `admin.data.export` is 7C's.

**The `PERMISSION[…]` reference ships in this task, not in Task 12.** §3.6.3's `permission-catalogue` lint fails the build on a catalogue code with no handler reference, and Global Constraints requires all five commands green **at the end of every task**. So this task also creates `apps/api/src/reports/authorise.ts` holding `requireReportExport` — the one function that names the code — with its own unit test. Task 12 *appends* `requireReportRead`, `resolveDefinitionForRun` and `assertParameters` to the same file and never edits this function. That is exactly what the File Structure already assigns (`apps/api/src/reports/authorise.ts NEW requireReportExport (T3)`).

**Files:**
- Create: `packages/db/migrations/0076_seed_permission_phase7a.sql`, `packages/db/migrations/0076.down.sql`, `apps/api/src/reports/authorise.ts`, `apps/api/test/reports/authorise.test.ts`
- Modify: `packages/contracts/permissions.ts`, `packages/db/seed/roles.ts`, `packages/db/test/permission-catalogue.test.ts`, `packages/db/test/roles-seed.test.ts`

**Interfaces:**
- Consumes: `PERMISSIONS`, `PermissionDef`, `SliceId` from `packages/contracts/permissions.ts` (§4.2.5); `ROLES`, `RoleSeed`, `INCOMPATIBLE_PAIRS` from `packages/db/seed/roles.ts` (§4.2.5, §3.6.4); `AppError` (§4.2.4); `AppEnv` from `apps/api/src/context.ts` (§4.2.3); `startApi`, `StartedApi` (§4.2.12); `seedTenantV2`, `grantCodes` (§4.17).
- Produces:

```ts
// packages/contracts/permissions.ts — one appended PermissionDef, PERMISSIONS grows additively
// { code: "accounting.report.export", module: "accounting", mutating: false, description: …, phase: "7A" }
// packages/contracts — the derived types widen automatically:
//   PermissionCode gains "accounting.report.export"; PERMISSION["accounting.report.export"] becomes legal.

// apps/api/src/reports/authorise.ts (Task 12 appends three more functions to this file)
/** `accounting.report.export` — the compile-time `PERMISSION[…]` reference that satisfies §3.6.3 for this
 *  slice's code. Throws AppError ERR_RBAC_FORBIDDEN naming the code and the company. */
export async function requireReportExport(c: Context<AppEnv>, companyId: string): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/permission-catalogue.test.ts` — the file 0B created; the existing `it`s are not edited:

```ts
  it("7A adds accounting.report.export, non-mutating, and nothing else (§3.6.2)", async () => {
    const rows = await db.migrator<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code like 'accounting.report.%' order by code`;
    expect(rows).toEqual([
      { code: "accounting.report.export", module: "accounting", mutating: false },
      { code: "accounting.report.read", module: "accounting", mutating: false },
    ]);
  });
```

And append to **`packages/db/test/roles-seed.test.ts`** — 0D's file, the one place a role grant is asserted, where 1A put its own three role `it`s (1a:988–1013) — a role assertion that reads the seed rather than the database, because `ROLES` is TypeScript data (§3.4.8). The file already imports `ROLES` from `../seed/roles` and `PERMISSIONS` from `@dulja/contracts/permissions` (0D Task 14 Step 1, extended by 1A Task 1); both are **top-level static** imports there, so this `it` uses them as they stand and adds no import of its own. Do not write a dynamic `await import(…)` — 0D's and 1A's static form is the settled precedent in this file and a dynamic one reads as an attempt to dodge a lint that does not exist:

```ts
  it("the auditor role holds accounting.report.export and no mutating code (spec:2163, R7)", () => {
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    expect(auditor.permissions).toContain("accounting.report.export");
    const mutating = new Set(PERMISSIONS.filter((p) => p.mutating).map((p) => p.code));
    expect(auditor.permissions.filter((c) => mutating.has(c))).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts test/roles-seed.test.ts`
Expected: FAIL twice — the catalogue `it` sees only `accounting.report.read`, and the role `it` reports `expected [ …the auditor's read codes so far… ] to contain 'accounting.report.export'` (the array's exact contents are whatever 1A–6D granted the auditor; the assertion is `toContain`, so it does not pin them).

- [ ] **Step 3: Add the catalogue row**

In `packages/contracts/permissions.ts`, append to the `PERMISSIONS` array beside 1B's `accounting.report.read` row. `PERMISSIONS` grows additively and no existing entry is edited:

```ts
  {
    code: "accounting.report.export",
    module: "accounting",
    mutating: false,
    description: "Export a report as PDF, XLSX or CSV (spec:2146; the auditor's export authority, spec:2163)",
    phase: "7A",
  },
```

`SliceId` already contains `"7A"` (§4.2.5) — no type edit is needed.

- [ ] **Step 4: Add the role grant**

In `packages/db/seed/roles.ts`, add the code to the `auditor` entry's `permissions` array. §3.6.4 records the grants so far — `accounting.party.manage → user` (2A) and `accounting.document.reverse → accountant` (2B) — and this slice adds one line to that sentence in the same PR: **`accounting.report.export` → `auditor`** (spec:2163, the only role the spec's table gives export authority; `admin.permissions` is computed from `PERMISSIONS` and is never edited).

```ts
    permissions: [
      // … the auditor's existing read codes, unchanged …
      "accounting.report.export",         // spec:2163 "Read everything financial … and export"; mutating: false, so R7 holds
    ],
```

- [ ] **Step 5: Write migration 0076 and its down file**

`packages/db/migrations/0076_seed_permission_phase7a.sql`:

```sql
-- ── 0076. Phase 7A permission codes ───────────────────────────────────────────
-- app.permission is GLOBAL (no tenant_id, no RLS, read-only for app_rw — plan0A:1254), so it is migration
-- data, not seed-pack data (§3.4.8). spec:2146 names the code; §3.6.2 assigns it to this slice.
-- packages/db/test/permission-catalogue.test.ts asserts this set equals permissions.ts in both directions.
insert into app.permission (code, module, mutating, description) values
  ('accounting.report.export', 'accounting', false,
   'Export a report as PDF, XLSX or CSV (spec:2146; the auditor''s export authority, spec:2163)')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
```

`packages/db/migrations/0076.down.sql`:

```sql
-- 0076.down.sql — deletes exactly the code the up inserted (§3.6.3).
--
-- PRECONDITION (contracts §3.4.5): this down is reversible only against an UNSEEDED database.
-- It deletes the one catalogue row and deliberately does NOT touch the role grant that the seed tier
-- (packages/db/seed/roles.ts, applied by `seed --only roles`) holds for that code, because it cannot:
-- (1) app.role_permission.permission_code references app.permission(code) with no `on delete` action, and
--     referential-integrity checks bypass RLS — so on a database where `--only roles` has run, this delete
--     does not silently orphan the auditor's grant, it RAISES SQLSTATE 23503;
-- (2) a `delete from app.role_permission` here would affect ZERO rows anyway — app_meta.enable_tenant_rls
--     applies FORCE ROW LEVEL SECURITY, which binds the table owner too, and a migration sets no
--     app.tenant_id (§3.4.8);
-- (3) nor can this file discover the tenants to set a context FOR — app.tenant is itself forced with
--     `using (id = app.current_tenant())`, so the migrator enumerating it sees nothing.
-- The operator, not this file, removes the grant per tenant first (a seed-tier act, under
-- `set_config('app.tenant_id', …)`), and re-runs `bun run seed --tenant <id> --only roles` after
-- re-migrating. NEVER disable or drop the policy to make this file "work" — LEGACY-027, LEGACY-041, LEGACY-053.
delete from app.permission where code = 'accounting.report.export';
```

**The precondition on this migration's rollback command (§3.4.5).** The command is `bun run --cwd packages/db db:rollback 75` — 0A's CLI passes the argument to `down(sql, dir, toVersion)`, which rolls back every applied version **above** it newest-first, so `75` undoes 0076 and nothing else. **It succeeds only where no tenant has been seeded** — the state §3.4.6's generalised reversibility test runs every down file in, and the state a CI database is in. On a database where `bun run seed --tenant <id> --only roles` has run, the command fails with SQLSTATE 23503 naming `app.role_permission`, and that failure is correct behaviour rather than a defect in the file: the operator removes the grant per tenant with a tenant context set, rolls back, and re-runs `--only roles` after re-migrating. Re-migrating re-inserts the `app.permission` row and nothing else — the two tiers are separate, which is the whole of §3.4.5: the `auditor` grant Step 4 writes into `packages/db/seed/roles.ts` is seed-pack data and comes back **only** from `--only roles`. 6A's `0062.down.sql` and 6B's `0063.down.sql` are the two written precedents and carry the same note.

- [ ] **Step 6: Write the failing gate test**

`apps/api/test/reports/authorise.test.ts`. `requireReportExport` reads exactly one context member — `c.var.withTenant` — so it is unit-testable against a hand-built context rather than through a route; that is the whole reason it is a plain function and not middleware.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "hono";
import type { Sql } from "postgres";
import { grantCodes, seedTenantV2, type Seed } from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { AppError } from "@dulja/contracts";
import { requireReportExport } from "../../src/reports/authorise";
import { startApi, type StartedApi } from "../support/app";
import type { AppEnv } from "../../src/context";

let api: StartedApi;
let holder: Seed;
let bare: Seed;

/** The two members `requireReportExport` touches, and nothing else — §4.2.3's `withTenant` variable. */
function contextFor(s: Seed): Context<AppEnv> {
  return {
    var: {
      withTenant: <T>(fn: (tx: Sql) => Promise<T>) =>
        withTenant(api.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() }, fn),
    },
  } as unknown as Context<AppEnv>;
}

beforeAll(async () => {
  api = await startApi();
  holder = await seedTenantV2(api.db, "authorise-holder");
  bare = await seedTenantV2(api.db, "authorise-bare");
  await grantCodes(api.db, holder, { codes: ["accounting.report.export"] });
});
afterAll(async () => { await api.stop(); });

describe("requireReportExport — §3.6.3's PERMISSION[…] reference and the gate it evaluates", () => {
  it("allows a principal holding accounting.report.export", async () => {
    await expect(requireReportExport(contextFor(holder), holder.company)).resolves.toBeUndefined();
  });

  it("refuses a principal without it, naming the code and the company (spec:2051)", async () => {
    try {
      await requireReportExport(contextFor(bare), bare.company);
      expect.unreachable("a principal with no codes must be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("ERR_RBAC_FORBIDDEN");
      expect((e as AppError).message).toContain("accounting.report.export");
      expect((e as AppError).message).toContain(bare.company);
    }
  });
});
```

Run: `bun run --cwd apps/api test -- reports/authorise`
Expected: FAIL — `Failed to resolve import "../../src/reports/authorise"`.

- [ ] **Step 7: Write `requireReportExport`**

`apps/api/src/reports/authorise.ts` — created here with **one** function. Task 12 appends `requireReportRead`, `resolveDefinitionForRun` and `assertParameters` below it and never edits this one.

```ts
import type { Context } from "hono";
import { AppError } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import type { AppEnv } from "../context";

/**
 * `accounting.report.export` — 7A's own code, referenced by `PERMISSION[…]` so §3.6.3's handler-↔-catalogue
 * lint is satisfied in the same task that seeds the row. It cannot be `requirePermission` middleware on the
 * `POST`: the code is `mutating: false` (spec:2147) and `assertRouteGates` throws `ERR_ROUTE_GATE_READONLY`
 * at boot for a non-mutating gate on an unsafe method (§4.2.5). That boot check is deliberate and this is its
 * intended escape: spec:2163 gives the `auditor` export authority, and R7 forbids the auditor holding any
 * mutating code.
 */
export async function requireReportExport(c: Context<AppEnv>, companyId: string): Promise<void> {
  const code = PERMISSION["accounting.report.export"];
  const allowed = await c.var.withTenant(async (tx) => {
    const [row] = await tx<{ ok: boolean }[]>`select app.actor_has(${code}, ${companyId}::uuid) as ok`;
    return row?.ok === true;
  });
  if (!allowed) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `rendering a report requires '${code}' in company ${companyId}`,
    );
  }
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `bun run --cwd packages/db test -- test/permission-catalogue.test.ts test/roles-seed.test.ts && bun run --cwd apps/api test -- reports/authorise && bun run lint:rules && bun run typecheck`
Expected: PASS throughout — including `lint:rules`, because `requireReportExport` supplies the `PERMISSION["accounting.report.export"]` reference §3.6.3's `permission-catalogue` rule looks for. A red `lint:rules` here means Step 7's file was not created; it is not an expected state.

- [ ] **Step 9: Commit**

```bash
git add packages/db/migrations/0076_seed_permission_phase7a.sql packages/db/migrations/0076.down.sql \
        packages/contracts/permissions.ts packages/db/seed/roles.ts \
        packages/db/test/permission-catalogue.test.ts packages/db/test/roles-seed.test.ts \
        apps/api/src/reports/authorise.ts apps/api/test/reports/authorise.test.ts
git commit -m "$(cat <<'EOF'
feat(db): seed accounting.report.export and grant it to auditor [7A T3]

Migration 0076 with §3.6.2's one code for this slice; the catalogue row in
permissions.ts and the auditor grant in roles.ts land in the same PR so
permission-catalogue.test.ts holds in both directions. requireReportExport ships
here too — it is the PERMISSION[…] reference §3.6.3's lint requires, so the tree
stays green rather than carrying a known-red lint:rules for nine tasks. T12
appends the other three helpers to the same file.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `ReportDefinition` format — JSON Schema, the generated type, the code grammar, and `validateReportDefinition`

§4.11.1 fixes the shape and §4.16.1 fixes the code grammar `^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$` — **exactly two segments**, the first being the definition's own `module`, so a code can never disagree with its module and can never be mistaken for a three-segment permission code. This task ships the schema, the committed type generated from it (1A's pattern, reusing 1A's option module rather than inventing a second generator), the grammar helpers, and the validator.

**The validator's two closed sets arrive as parameters, not imports.** `DatasetId` lives in `packages/db/src/reports/datasets.ts` (§4.16.2) and `PermissionCode` in `packages/contracts/permissions.ts` (§4.2.5), and `packages/domain` imports **nothing internal** (§3.1). So `validateReportDefinition(definition, { datasets, permissions })` takes both as `ReadonlySet<string>` — exactly the shape 1A chose for `validatePolicy(definition, catalogue)` and 0D for `adminPermissions(catalogue)`. `packages/db` calls it with `new Set(DATASET_IDS)` and the codes it reads from `select code from app.permission`; `apps/api` does the same. The JSON Schema checks **grammar only** — a `pattern` on `code` and `dataset.source`, and nothing about membership, because a schema cannot know which slices have shipped.

**Files:**
- Create: `packages/domain/report-definition.schema.json`, `packages/domain/scripts/generate-report-type.ts`, `packages/domain/src/reports/definition.ts` (generated), `packages/domain/src/reports/error.ts`, `packages/domain/src/reports/codes.ts`, `packages/domain/src/reports/validate.ts`, `packages/domain/src/reports/index.ts`, `packages/domain/test/reports/definition.test.ts`, `packages/domain/test/reports/report-type.test.ts`, `packages/contracts/test/report-filter-ops.test.ts`, `docs/adr/0065-report-definition-format.md`
- Modify: `packages/domain/package.json`, `packages/domain/scripts/policy-type-options.ts`, `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `Ajv2020` and `addFormats` (already dependencies of `packages/domain` from 1A's ADR 0022 — the lockfile owns the versions, spec:104); `POLICY_TYPE_BANNER`, `POLICY_TYPE_OPTIONS` from `packages/domain/scripts/policy-type-options.ts` (1A, §4.18 round 2); `FILTER_OPS` from `@dulja/contracts` (§4.2.8) — **only in the contracts-tier test**, never from `packages/domain`.
- Produces:

```ts
// packages/domain/src/reports/codes.ts
export type ReportModule = "accounting" | "inventory" | "hr" | "pos";
export const REPORT_MODULES: readonly ReportModule[];                    // ["accounting","inventory","hr","pos"]
/** §4.16.1's grammar. Two segments; the first is the module. The register itself is §4.16.1, not a TS const. */
export const REPORT_CODE_PATTERN: RegExp;                                // /^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/
export type ReportCode = string & { readonly __brand: "ReportCode" };
export function isReportCode(value: unknown): value is ReportCode;
export function reportCode(value: string): ReportCode;                   // throws ReportDefinitionError
export function moduleOfReportCode(code: string): ReportModule;          // throws ReportDefinitionError

/** The eight operators of §4.11.1's `dataset.filters[].op`. The same eight tokens as `@dulja/contracts`'
 *  `FILTER_OPS` (§4.2.8) — the two lists are pinned equal by packages/contracts/test/report-filter-ops.test.ts,
 *  because `packages/domain` may not import `@dulja/contracts` (§3.1) and one vocabulary must not fork. */
export const REPORT_FILTER_OPS: readonly ["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"];
export type ReportFilterOp = (typeof REPORT_FILTER_OPS)[number];

export type ReportFormat = "pdf" | "xlsx" | "csv";
export const REPORT_FORMATS: readonly ReportFormat[];
export type ReportLang = "en" | "ar";
export type ReportPaper = "A4" | "A5" | "receipt";                       // §4.5.9's registered vocabulary — no fourth token
export type ReportOrientation = "portrait" | "landscape";
export type ReportColumnFormat = "text" | "money" | "quantity" | "date" | "integer" | "percent";

// packages/domain/src/reports/definition.ts — GENERATED from report-definition.schema.json
export interface ReportDefinition { /* the full shape below */ }
export interface ReportParameter { /* … */ }
export interface ReportColumn { /* … */ }

// packages/domain/src/reports/error.ts — its OWN module, imported by BOTH codes.ts and validate.ts.
// `codes.ts` throws it from `reportCode()`; `validate.ts` throws it from `parseReportDefinition()`. If it
// lived in either of those two, the other would import it back and close a module cycle (hazard 9).
export class ReportDefinitionError extends Error {
  readonly code: "ERR_VALIDATION_FAILED";
  readonly errors: readonly { path: string; message: string }[];
  constructor(detail: string, errors?: readonly { path: string; message: string }[]);
}

// packages/domain/src/reports/validate.ts
export interface ReportDefinitionValidation { ok: boolean; errors: { path: string; message: string }[] }
export interface ReportDefinitionSets {
  /** Every member of `DatasetId` whose owning slice has shipped — `new Set(DATASET_IDS)` at the db tier. */
  readonly datasets: ReadonlySet<string>;
  /** Every permission code in `app.permission` — the F-21 rule: a definition may not name a code no slice seeded. */
  readonly permissions: ReadonlySet<string>;
}
/** Schema + grammar + the two closed sets + internal referential integrity. `errors[]` entries are JSON
 *  Pointers into the rejected definition, which is what §4.2.4 lets `ERR_VALIDATION_FAILED` carry. */
export function validateReportDefinition(definition: unknown, sets: ReportDefinitionSets): ReportDefinitionValidation;
/** Schema and grammar only, no set membership — for a definition already stored and validated. Throws. */
export function parseReportDefinition(definition: unknown): ReportDefinition;
```

- [ ] **Step 1: Write the failing test**

`packages/domain/test/reports/definition.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  REPORT_CODE_PATTERN, REPORT_FILTER_OPS, ReportDefinitionError, isReportCode,
  moduleOfReportCode, parseReportDefinition, reportCode, validateReportDefinition,
} from "../../src/reports";

const DATASETS = new Set(["account_balance", "ledger_entry", "stock_on_hand"]);
const PERMISSIONS = new Set(["accounting.report.read", "accounting.report.export", "inventory.stock.read"]);
const SETS = { datasets: DATASETS, permissions: PERMISSIONS };

/** A minimal but complete definition. Every later test derives from it by one edit. */
function base() {
  return {
    version: 1,
    code: "accounting.trial_balance",
    nameEn: "Trial balance",
    nameAr: "ميزان المراجعة",
    module: "accounting",
    permission: "accounting.report.read",
    parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
    dataset: {
      source: "account_balance",
      filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }],
    },
    columns: [
      // `account_type` is FIRST and is a real column, because `groups[0].field` below names it and validator
      // rule 4 refuses a group field that is not one of the definition's own columns. Every later `it` in this
      // file derives from `base()` by one edit and asserts an EXACT `errors` array, so a base definition that
      // was itself invalid would fail roughly eight of them.
      { field: "account_type", labelEn: "Type", labelAr: "النوع", format: "text", align: "start", width: 90 },
      { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start", width: 80 },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
      { field: "base_credit", labelEn: "Credit", labelAr: "دائن", format: "money", align: "end" },
    ],
    groups: [{ field: "account_type", subtotal: true }],
    totals: [{ field: "base_debit", fn: "sum" }, { field: "base_credit", fn: "sum" }],
    sort: [{ field: "account_code", dir: "asc" }],
    layout: { orientation: "portrait", paper: "A4", header: "{nameEn} — {fiscalPeriodId}", footer: "{page}" },
    tieOut: { kind: "ledger_sum" },
  };
}

describe("the ReportCode grammar — contracts §4.16.1", () => {
  it("accepts exactly two segments whose first is a module", () => {
    for (const code of ["accounting.trial_balance", "inventory.stock_on_hand", "pos.z_report", "hr.payslip"]) {
      expect(REPORT_CODE_PATTERN.test(code), code).toBe(true);
      expect(isReportCode(code), code).toBe(true);
    }
  });

  it("refuses a three-segment permission-shaped code, an unknown module, and a short tail", () => {
    for (const bad of [
      "accounting.report.read",       // three segments — a permission code, not a report code
      "admin.data_export",            // 'admin' is not a report module (§4.16.1)
      "accounting.ab",                // the tail needs at least three characters
      "accounting.Trial_Balance",     // upper case
      "accounting.trial-balance",     // hyphen
      "accounting.",
      "trial_balance",
    ]) {
      expect(REPORT_CODE_PATTERN.test(bad), bad).toBe(false);
      expect(isReportCode(bad), bad).toBe(false);
      expect(() => reportCode(bad), bad).toThrow(ReportDefinitionError);
    }
  });

  it("reads the module off the code, so a definition can never disagree with it", () => {
    expect(moduleOfReportCode("inventory.stock_ageing")).toBe("inventory");
    expect(() => moduleOfReportCode("nope.x_y")).toThrow(ReportDefinitionError);
  });
});

describe("REPORT_FILTER_OPS", () => {
  it("is the eight operators of §4.11.1 in a fixed order", () => {
    expect([...REPORT_FILTER_OPS]).toEqual(["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"]);
  });
});

describe("validateReportDefinition — contracts §4.11.1", () => {
  it("accepts the base definition", () => {
    expect(validateReportDefinition(base(), SETS)).toEqual({ ok: true, errors: [] });
  });

  it("refuses a dataset id outside the closed registry, naming the JSON path", () => {
    const def = base();
    def.dataset.source = "invoices";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{
      path: "/dataset/source",
      message: "dataset 'invoices' is not a member of the closed DatasetId registry (contracts §4.16.2)",
    }]);
  });

  it("refuses a permission code no slice has seeded (F-21)", () => {
    const def = base();
    def.permission = "accounting.report.print";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{
      path: "/permission",
      message: "permission 'accounting.report.print' is not in the permission catalogue",
    }]);
  });

  it("refuses a module that disagrees with the code's first segment", () => {
    const def = base();
    def.module = "inventory";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{
      path: "/module",
      message: "module 'inventory' disagrees with code 'accounting.trial_balance' (contracts §4.16.1)",
    }]);
  });

  it("refuses a filter naming a parameter the definition does not declare", () => {
    const def = base();
    def.dataset.filters = [{ field: "fiscal_period_id", op: "eq", param: "periodId" }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{
      path: "/dataset/filters/0/param",
      message: "filter references parameter 'periodId', which the definition does not declare",
    }]);
  });

  it("refuses a group, total or sort field that is not a declared column", () => {
    const def = base();
    def.groups = [{ field: "branch_code", subtotal: true }];
    def.totals = [{ field: "quantity", fn: "sum" }];
    def.sort = [{ field: "posted_at", dir: "desc" }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    // `validateReportDefinition` ends with `errors.sort((x, y) => …)` on `path`, so the order asserted here is
    // ALPHABETICAL by JSON Pointer ('g' < 's' < 't'), not the order the three rules pushed in.
    expect(result.errors.map((e) => e.path)).toEqual(["/groups/0/field", "/sort/0/field", "/totals/0/field"]);
    expect(result.errors[0]!.message)
      .toBe("group field 'branch_code' is not one of this definition's columns");
  });

  it("refuses a sum or avg over a non-numeric column", () => {
    const def = base();
    def.totals = [{ field: "account_code", fn: "sum" }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([{
      path: "/totals/0/fn",
      message: "total fn 'sum' needs a money, quantity, integer or percent column; 'account_code' is text",
    }]);
  });

  it("refuses an enum parameter with no options and duplicate parameter or column names", () => {
    const def = base();
    def.parameters = [
      { name: "kind", kind: "enum", required: true },
      { name: "kind", kind: "text", required: false },
    ];
    // `base()`'s ONE filter names `fiscalPeriodId`, which the line above has just un-declared, so rule 5
    // would push a fourth error at `/dataset/filters/0/param` and this exact-array assertion would fail.
    // The subject of this `it` is parameters and columns, so the filter is cleared rather than expected:
    // the rule-5 refusal has its own `it` above ("refuses a filter naming a parameter the definition does
    // not declare"), and an empty `filters` array is valid — the schema sets no `minItems` on it.
    def.dataset.filters = [];
    def.columns = [...def.columns, { ...def.columns[0]! }];
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    // `base()` declares FOUR columns, so the appended duplicate is index 4.
    expect(result.errors.map((e) => e.path).sort()).toEqual([
      "/columns/4/field", "/parameters/0/options", "/parameters/1/name",
    ]);
  });

  it("refuses a paper token outside §4.5.9's registered three", () => {
    const def = base();
    (def.layout as { paper: string }).paper = "letter";
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe("/layout/paper");
  });

  it("refuses a tieOut of kind projection with no projection name", () => {
    const a = base();
    a.tieOut = { kind: "projection" } as { kind: "projection" };
    expect(validateReportDefinition(a, SETS).errors).toEqual([{
      path: "/tieOut/projection",
      message: "tieOut kind 'projection' requires a projection name",
    }]);
  });

  it("refuses a tieOut of kind ledger_sum with neither an account nor a total, and accepts it with a total", () => {
    // Rule 6 deliberately admits `ledger_sum` with no account WHEN `totals` is non-empty — which is exactly
    // what `STATEMENT_LAYOUTS` relies on (Task 9): a statement's tie-out compares its grand total, not one
    // account code. The refusal is only for a definition that offers the harness nothing to compare.
    const empty = base();
    empty.tieOut = { kind: "ledger_sum" };
    empty.totals = [];
    expect(validateReportDefinition(empty, SETS).errors).toEqual([{
      path: "/tieOut/account",
      message: "tieOut kind 'ledger_sum' requires an account code or at least one total to compare",
    }]);

    const withTotal = base();
    withTotal.tieOut = { kind: "ledger_sum" };
    expect(validateReportDefinition(withTotal, SETS)).toEqual({ ok: true, errors: [] });
  });

  it("refuses additional properties anywhere (the anti-blob rule of spec:1246, LEGACY-078)", () => {
    const def = { ...base(), sqlOverride: "select * from app.ledger_entry" };
    const result = validateReportDefinition(def, SETS);
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.path).toBe("/sqlOverride");
  });
});

describe("parseReportDefinition", () => {
  it("returns the typed definition", () => {
    expect(parseReportDefinition(base()).code).toBe("accounting.trial_balance");
  });

  it("throws ReportDefinitionError carrying JSON-Pointer paths, and checks no set membership", () => {
    const def = base();
    def.dataset.source = "not_a_dataset_but_grammatical";
    // parse checks the schema and the grammar only — membership belongs to validate, because a stored
    // definition was validated when it was written and the registry may have grown since (§4.16.2).
    expect(parseReportDefinition(def).dataset.source).toBe("not_a_dataset_but_grammatical");
    try {
      parseReportDefinition({ ...base(), version: 2 });
      expect.unreachable("version 2 must be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ReportDefinitionError);
      expect((e as ReportDefinitionError).code).toBe("ERR_VALIDATION_FAILED");
      expect((e as ReportDefinitionError).errors[0]!.path).toBe("/version");
    }
  });
});
```

`packages/contracts/test/report-filter-ops.test.ts` — the pin that keeps one vocabulary from forking:

```ts
import { describe, expect, it } from "vitest";
import { REPORT_FILTER_OPS } from "@dulja/domain";
import { FILTER_OPS } from "../src/common";

describe("the filter-operator vocabulary is one list, spelled twice by the dependency rule", () => {
  it("@dulja/contracts' FILTER_OPS and @dulja/domain's REPORT_FILTER_OPS are equal, in order", () => {
    // §3.1 makes `packages/domain` import nothing internal, so the eight tokens §4.2.8 fixes for the API's
    // filter grammar and the eight §4.11.1 fixes for a ReportDefinition's dataset filters cannot be one
    // constant. `packages/contracts` imports `@dulja/domain`, so this is the one place they can meet — and
    // this assertion is what stops the two from drifting (hazard 9: one thing, one spelling).
    expect([...FILTER_OPS]).toEqual([...REPORT_FILTER_OPS]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/domain test -- reports/definition`
Expected: FAIL — `Failed to resolve import "../../src/reports"`, because the directory does not exist.

- [ ] **Step 3: Write the JSON Schema**

`packages/domain/report-definition.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:dulja:report-definition:1",
  "title": "ReportDefinition",
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "code", "nameEn", "nameAr", "module", "permission", "parameters", "dataset", "columns", "groups", "totals", "sort", "layout", "tieOut"],
  "properties": {
    "version": { "const": 1 },
    "code": { "type": "string", "pattern": "^(accounting|inventory|hr|pos)\\.[a-z][a-z0-9_]{2,47}$" },
    "nameEn": { "type": "string", "minLength": 1 },
    "nameAr": { "type": "string", "minLength": 1 },
    "module": { "enum": ["accounting", "inventory", "hr", "pos"] },
    "permission": { "type": "string", "pattern": "^(admin|accounting|inventory|hr|pos)\\.[a-z_]+\\.[a-z_]+$" },
    "parameters": { "type": "array", "items": { "$ref": "#/$defs/parameter" } },
    "dataset": {
      "type": "object",
      "additionalProperties": false,
      "required": ["source", "filters"],
      "properties": {
        "source": { "type": "string", "pattern": "^[a-z][a-z0-9_]{2,47}$" },
        "filters": { "type": "array", "items": { "$ref": "#/$defs/filter" } }
      }
    },
    "columns": { "type": "array", "minItems": 1, "items": { "$ref": "#/$defs/column" } },
    "groups": { "type": "array", "items": { "$ref": "#/$defs/group" } },
    "totals": { "type": "array", "items": { "$ref": "#/$defs/total" } },
    "sort": { "type": "array", "items": { "$ref": "#/$defs/sortKey" } },
    "layout": {
      "type": "object",
      "additionalProperties": false,
      "required": ["orientation", "paper", "header", "footer"],
      "properties": {
        "orientation": { "enum": ["portrait", "landscape"] },
        "paper": { "enum": ["A4", "A5", "receipt"] },
        "header": { "type": "string" },
        "footer": { "type": "string" }
      }
    },
    "tieOut": {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind"],
      "properties": {
        "kind": { "enum": ["ledger_sum", "projection", "none"] },
        "account": { "type": "string", "pattern": "^[0-9A-Z][0-9A-Za-z_]{0,31}$" },
        "projection": { "type": "string", "pattern": "^[a-z][a-z0-9_]{2,47}$" }
      }
    }
  },
  "$defs": {
    "parameter": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "kind", "required"],
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]{0,47}$" },
        "kind": { "enum": ["date", "date_range", "period", "account", "party", "item", "warehouse", "branch", "dimension_value", "enum", "text"] },
        "required": { "type": "boolean" },
        "options": { "type": "array", "minItems": 1, "uniqueItems": true, "items": { "type": "string", "minLength": 1 } }
      }
    },
    "filter": {
      "type": "object",
      "additionalProperties": false,
      "required": ["field", "op", "param"],
      "properties": {
        "field": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,47}$" },
        "op": { "enum": ["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"] },
        "param": { "type": "string", "pattern": "^[a-z][A-Za-z0-9]{0,47}$" }
      }
    },
    "column": {
      "type": "object",
      "additionalProperties": false,
      "required": ["field", "labelEn", "labelAr", "format", "align"],
      "properties": {
        "field": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,47}$" },
        "labelEn": { "type": "string", "minLength": 1 },
        "labelAr": { "type": "string", "minLength": 1 },
        "format": { "enum": ["text", "money", "quantity", "date", "integer", "percent"] },
        "align": { "enum": ["start", "end"] },
        "width": { "type": "integer", "minimum": 8, "maximum": 400 }
      }
    },
    "group": {
      "type": "object",
      "additionalProperties": false,
      "required": ["field", "subtotal"],
      "properties": {
        "field": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,47}$" },
        "subtotal": { "type": "boolean" }
      }
    },
    "total": {
      "type": "object",
      "additionalProperties": false,
      "required": ["field", "fn"],
      "properties": {
        "field": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,47}$" },
        "fn": { "enum": ["sum", "count", "avg"] }
      }
    },
    "sortKey": {
      "type": "object",
      "additionalProperties": false,
      "required": ["field", "dir"],
      "properties": {
        "field": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,47}$" },
        "dir": { "enum": ["asc", "desc"] }
      }
    }
  }
}
```

**Two schema decisions worth stating.** `additionalProperties: false` at every level is what makes a definition a *reviewable document* rather than an opaque blob — spec:1246 puts "Delphi-serialised report files" on the do-not-carry-over list and LEGACY-078 is the defect ("configuration that determines system behaviour is undiffable, unreviewable, untestable"). Without it, a `sqlOverride` key would be silently carried and test 27 would have a hole. And `"version": { "const": 1 }`: a schema change is a **new** `const` and a **new** `$id`, exactly as §4.4.1 rules for the posting policy — never a widened `enum` on the same `$id`.

- [ ] **Step 4: Extend 1A's generator-option module and write the generator**

Append to `packages/domain/scripts/policy-type-options.ts` — 1A's file, whose `POLICY_TYPE_BANNER` and `POLICY_TYPE_OPTIONS` are shared by its generator and its drift guard (§4.18 round 2). The two new consts sit beside them so both generators emit byte-identical formatting:

```ts
export const REPORT_TYPE_BANNER = [
  "// GENERATED FILE — do not edit by hand.",
  "// Source: packages/domain/report-definition.schema.json ($id urn:dulja:report-definition:1)",
  "// Regenerate: bun run --cwd packages/domain report:types",
  "",
].join("\n");

/** The same option object as POLICY_TYPE_OPTIONS with this schema's banner. Sharing the object is what keeps
 *  the two generated files formatted identically, so a reviewer diffing either sees only real changes. */
export const REPORT_TYPE_OPTIONS = { ...POLICY_TYPE_OPTIONS, bannerComment: REPORT_TYPE_BANNER };
```

`packages/domain/scripts/generate-report-type.ts`:

```ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";
import { REPORT_TYPE_OPTIONS } from "./policy-type-options";

const schema = fileURLToPath(new URL("../report-definition.schema.json", import.meta.url));
const out = fileURLToPath(new URL("../src/reports/definition.ts", import.meta.url));

const source = await compileFromFile(schema, REPORT_TYPE_OPTIONS);
writeFileSync(out, source, "utf8");
```

Add the script to `packages/domain/package.json` beside 1A's `policy:types` (no version literal — the two devDependencies `json-schema-to-typescript` and `ajv` are already there from 1A; the lockfile owns their versions, spec:104):

```json
    "report:types": "bun run scripts/generate-report-type.ts"
```

- [ ] **Step 5: Generate and commit the type**

Run: `bun run --cwd packages/domain report:types`

The generator writes `packages/domain/src/reports/definition.ts`. **Keep its output; do not hand-edit it** — if `json-schema-to-typescript` names an inner interface differently from the shape below, its name is the one every later task must use, and the drift guard in Step 8 is what enforces that. The expected shape:

```ts
// GENERATED FILE — do not edit by hand.
// Source: packages/domain/report-definition.schema.json ($id urn:dulja:report-definition:1)
// Regenerate: bun run --cwd packages/domain report:types

export interface ReportDefinition {
  version: 1;
  code: string;
  nameEn: string;
  nameAr: string;
  module: "accounting" | "inventory" | "hr" | "pos";
  permission: string;
  parameters: Parameter[];
  dataset: { source: string; filters: Filter[] };
  columns: Column[];
  groups: Group[];
  totals: Total[];
  sort: SortKey[];
  layout: {
    orientation: "portrait" | "landscape";
    paper: "A4" | "A5" | "receipt";
    header: string;
    footer: string;
  };
  tieOut: { kind: "ledger_sum" | "projection" | "none"; account?: string; projection?: string };
}
export interface Parameter {
  name: string;
  kind: "date" | "date_range" | "period" | "account" | "party" | "item" | "warehouse" | "branch" | "dimension_value" | "enum" | "text";
  required: boolean;
  options?: string[];
}
export interface Filter { field: string; op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "like"; param: string }
export interface Column {
  field: string;
  labelEn: string;
  labelAr: string;
  format: "text" | "money" | "quantity" | "date" | "integer" | "percent";
  align: "start" | "end";
  width?: number;
}
export interface Group { field: string; subtotal: boolean }
export interface Total { field: string; fn: "sum" | "count" | "avg" }
export interface SortKey { field: string; dir: "asc" | "desc" }
```

**Why `code`, `permission` and `dataset.source` are `string` in the generated type.** §4.11.1 writes them as `ReportCode`, `PermissionCode` and `DatasetId`. A JSON Schema cannot express a TypeScript brand or a union whose members live in two other packages, so the schema carries the *pattern* and the generated type carries `string`. The narrowing happens in `validateReportDefinition`, which is the only door a definition enters through, and `isReportCode` is the type guard a caller uses when it needs the brand. Nothing is lost: the pattern is checked, membership is checked against the live registries, and a definition that skipped both would have to bypass the validator, which no route or loader does.

- [ ] **Step 6: Write the error module, then the grammar module**

`packages/domain/src/reports/error.ts` — the class both modules below throw. It is its **own** file for one
structural reason: `codes.ts` throws it from `reportCode()` and `validate.ts` throws it from
`parseReportDefinition()`, while `validate.ts` also imports `NUMERIC_COLUMN_FORMATS` and
`REPORT_CODE_PATTERN` from `codes.ts`. Putting the class in either of the two would close a module cycle —
survivable under ESM only for as long as neither side touches the other's bindings at top level, and a silent
break the first time one does. `packages/domain` may not import `@dulja/contracts` (§3.1), so this is the
`PolicyEvaluationError` precedent of §4.4.2 rather than an `AppError`.

```ts
/**
 * The domain-side validation error. `apps/api/src/problem.ts` translates it in one `asAppError` branch
 * (Task 5), and `errors[]` reaches the wire because §4.2.4's amendment A10 lets `ERR_VALIDATION_FAILED`
 * carry JSON-Pointer entries.
 */
export class ReportDefinitionError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  readonly errors: readonly { path: string; message: string }[];
  constructor(detail: string, errors: readonly { path: string; message: string }[] = []) {
    super(detail);
    this.name = "ReportDefinitionError";
    this.errors = errors;
  }
}
```

`packages/domain/src/reports/codes.ts`:

```ts
import { ReportDefinitionError } from "./error";

export type ReportModule = "accounting" | "inventory" | "hr" | "pos";
export const REPORT_MODULES: readonly ReportModule[] = ["accounting", "inventory", "hr", "pos"];

/**
 * contracts §4.16.1's frozen grammar: EXACTLY two segments, the first being the definition's own `module`.
 * Two segments is what makes a report code impossible to confuse with a three-segment permission code, and
 * deriving the module from the code is what makes the two impossible to disagree.
 */
export const REPORT_CODE_PATTERN = /^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/;

export type ReportCode = string & { readonly __brand: "ReportCode" };

export function isReportCode(value: unknown): value is ReportCode {
  return typeof value === "string" && REPORT_CODE_PATTERN.test(value);
}

export function reportCode(value: string): ReportCode {
  if (!isReportCode(value)) {
    throw new ReportDefinitionError(
      `'${value}' is not a report code: contracts §4.16.1 requires <module>.<name> with module in ${REPORT_MODULES.join(" | ")}`,
      [{ path: "/code", message: `'${value}' does not match ${REPORT_CODE_PATTERN.source}` }],
    );
  }
  return value;
}

export function moduleOfReportCode(code: string): ReportModule {
  const module = reportCode(code).split(".", 1)[0] as ReportModule;
  return module;
}

/** §4.11.1's `dataset.filters[].op`. Pinned equal to `@dulja/contracts`' FILTER_OPS by a contracts-tier test. */
export const REPORT_FILTER_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"] as const;
export type ReportFilterOp = (typeof REPORT_FILTER_OPS)[number];

export type ReportFormat = "pdf" | "xlsx" | "csv";
export const REPORT_FORMATS: readonly ReportFormat[] = ["pdf", "xlsx", "csv"];
export type ReportLang = "en" | "ar";
/** §4.5.9 registers this vocabulary for `print_template.paper`; §4.11.1's `layout.paper` uses the same three
 *  tokens and no slice invents a fourth without amending that section. */
export type ReportPaper = "A4" | "A5" | "receipt";
export type ReportOrientation = "portrait" | "landscape";
export type ReportColumnFormat = "text" | "money" | "quantity" | "date" | "integer" | "percent";

/** The formats a `sum` or `avg` total is defined over. `text` and `date` are excluded on purpose. */
export const NUMERIC_COLUMN_FORMATS: readonly ReportColumnFormat[] = ["money", "quantity", "integer", "percent"];
```

- [ ] **Step 7: Write the validator**

`packages/domain/src/reports/validate.ts`:

```ts
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import schema from "../../report-definition.schema.json" with { type: "json" };
import type { ReportDefinition } from "./definition";
import { NUMERIC_COLUMN_FORMATS, REPORT_CODE_PATTERN, type ReportColumnFormat } from "./codes";
import { ReportDefinitionError } from "./error";

export interface ReportDefinitionValidation {
  ok: boolean;
  errors: { path: string; message: string }[];
}

export interface ReportDefinitionSets {
  readonly datasets: ReadonlySet<string>;
  readonly permissions: ReadonlySet<string>;
}

// `ReportDefinitionError` is imported from `./error`, never declared here — see Step 6.

// One compiled validator per process. Ajv compiles on construction, not per call (1A's ADR 0022).
const ajv = new Ajv2020({ allErrors: true, strict: true });
const compiled: ValidateFunction<ReportDefinition> = ajv.compile<ReportDefinition>(schema);

/** Ajv's instancePath is already a JSON Pointer; an additionalProperties error points at the parent, so the
 *  offending key is appended to make the message actionable (LEGACY-084: name the specific offending entity). */
function pointerOf(e: ErrorObject): string {
  if (e.keyword === "additionalProperties") {
    const extra = (e.params as { additionalProperty: string }).additionalProperty;
    return `${e.instancePath}/${extra}`;
  }
  return e.instancePath === "" ? "/" : e.instancePath;
}

function schemaErrors(): { path: string; message: string }[] {
  return (compiled.errors ?? []).map((e) => ({ path: pointerOf(e), message: e.message ?? e.keyword }));
}

export function validateReportDefinition(
  definition: unknown,
  sets: ReportDefinitionSets,
): ReportDefinitionValidation {
  if (!compiled(definition)) return { ok: false, errors: schemaErrors() };
  const def = definition;
  const errors: { path: string; message: string }[] = [];

  // 1. the module must agree with the code's first segment (§4.16.1)
  const codeModule = def.code.match(REPORT_CODE_PATTERN)?.[1];
  if (codeModule !== def.module) {
    errors.push({
      path: "/module",
      message: `module '${def.module}' disagrees with code '${def.code}' (contracts §4.16.1)`,
    });
  }

  // 2. the two closed sets — never inside the schema, because a schema cannot know which slices have shipped
  if (!sets.datasets.has(def.dataset.source)) {
    errors.push({
      path: "/dataset/source",
      message: `dataset '${def.dataset.source}' is not a member of the closed DatasetId registry (contracts §4.16.2)`,
    });
  }
  if (!sets.permissions.has(def.permission)) {
    errors.push({
      path: "/permission",
      message: `permission '${def.permission}' is not in the permission catalogue`,
    });
  }

  // 3. parameter names are unique, and an enum parameter must offer options
  const seenParams = new Set<string>();
  def.parameters.forEach((p, i) => {
    if (seenParams.has(p.name)) {
      errors.push({ path: `/parameters/${i}/name`, message: `parameter '${p.name}' is declared twice` });
    }
    seenParams.add(p.name);
    if (p.kind === "enum" && (p.options === undefined || p.options.length === 0)) {
      errors.push({ path: `/parameters/${i}/options`, message: `enum parameter '${p.name}' declares no options` });
    }
  });

  // 4. column fields are unique, and every group / total / sort field is one of them
  const formatOf = new Map<string, ReportColumnFormat>();
  def.columns.forEach((c, i) => {
    if (formatOf.has(c.field)) {
      errors.push({ path: `/columns/${i}/field`, message: `column '${c.field}' is declared twice` });
    }
    formatOf.set(c.field, c.format);
  });
  def.groups.forEach((g, i) => {
    if (!formatOf.has(g.field)) {
      errors.push({ path: `/groups/${i}/field`, message: `group field '${g.field}' is not one of this definition's columns` });
    }
  });
  def.totals.forEach((t, i) => {
    const format = formatOf.get(t.field);
    if (format === undefined) {
      errors.push({ path: `/totals/${i}/field`, message: `total field '${t.field}' is not one of this definition's columns` });
      return;
    }
    if (t.fn !== "count" && !NUMERIC_COLUMN_FORMATS.includes(format)) {
      errors.push({
        path: `/totals/${i}/fn`,
        message: `total fn '${t.fn}' needs a money, quantity, integer or percent column; '${t.field}' is ${format}`,
      });
    }
  });
  def.sort.forEach((s, i) => {
    if (!formatOf.has(s.field)) {
      errors.push({ path: `/sort/${i}/field`, message: `sort field '${s.field}' is not one of this definition's columns` });
    }
  });

  // 5. every filter must name a declared parameter — this is what makes a value a bound parameter and never
  //    text spliced into SQL (test 27, LEGACY-069's root cause)
  def.dataset.filters.forEach((f, i) => {
    if (!seenParams.has(f.param)) {
      errors.push({
        path: `/dataset/filters/${i}/param`,
        message: `filter references parameter '${f.param}', which the definition does not declare`,
      });
    }
  });

  // 6. tieOut carries what its kind needs — the DoD's "every report's numbers tie to the ledger" (7B/7C)
  if (def.tieOut.kind === "ledger_sum" && def.tieOut.account === undefined && def.totals.length === 0) {
    errors.push({
      path: "/tieOut/account",
      message: "tieOut kind 'ledger_sum' requires an account code or at least one total to compare",
    });
  }
  if (def.tieOut.kind === "projection" && def.tieOut.projection === undefined) {
    errors.push({ path: "/tieOut/projection", message: "tieOut kind 'projection' requires a projection name" });
  }

  errors.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { ok: errors.length === 0, errors };
}

export function parseReportDefinition(definition: unknown): ReportDefinition {
  if (!compiled(definition)) {
    const errors = schemaErrors();
    throw new ReportDefinitionError(
      `report definition is invalid: ${errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
      errors,
    );
  }
  return definition;
}
```

`packages/domain/src/reports/index.ts`:

```ts
export * from "./error";
export * from "./codes";
export * from "./validate";
export type { Column, Filter, Group, Parameter, ReportDefinition, SortKey, Total } from "./definition";
```

Add `export * from "./reports";` to `packages/domain/src/index.ts`.

- [ ] **Step 8: Add the drift guard, then run everything to see it pass**

`packages/domain/test/reports/report-type.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("src/reports/definition.ts is generated, not hand-written", () => {
  it("regenerating produces no diff (the committed-artifact discipline of spec:2055)", () => {
    const path = fileURLToPath(new URL("../../src/reports/definition.ts", import.meta.url));
    const before = readFileSync(path, "utf8");
    execFileSync("bun", ["run", "report:types"], { cwd: fileURLToPath(new URL("../..", import.meta.url)) });
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
```

Run: `bun run --cwd packages/domain test -- reports && bun run --cwd packages/contracts test -- report-filter-ops && bun run typecheck`
Expected: PASS — every `it` in `definition.test.ts` and `report-type.test.ts`, plus the contracts-tier pin.

- [ ] **Step 9: Write ADR 0065**

`docs/adr/0065-report-definition-format.md`:

```markdown
# ADR 0065 — The report-definition format is validated JSON with a closed dataset registry

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 7A
- **Supersedes / superseded by:** —

## Context

spec:1240 wants "an end-user report designer — text-defined, diffable, version-controlled". spec:1246 puts
"Delphi-serialised report files" on the explicit do-NOT-carry-over list. LEGACY-077 is the defect they produce:
because report definitions lived as `MEMO` blobs inside customer databases, no static analysis could ever
determine whether a stored procedure was live, so near-duplicates accumulated instead of being consolidated.
LEGACY-069 is the other half: every report query was rebuilt, re-parsed and re-planned per call, concatenated
into a fixed-size buffer, with ~54 sites interpolating `DATE` parameters as text.

## Decision

1. **A definition is JSON validated against `packages/domain/report-definition.schema.json`**
   (`$id urn:dulja:report-definition:1`, `additionalProperties: false` at every level, `"version": {"const": 1}`).
   A schema change is a new `const` and a new `$id`, exactly as §4.4.1 rules for the posting policy.
2. **A definition never carries SQL.** `dataset.source` names a member of the closed `DatasetId` registry in
   `packages/db/src/reports/datasets.ts`, where every member is a named `withTenant` read query whose column
   references are literal SQL fragments authored in that file. A filter names a **declared parameter**, and the
   value reaches the query as a bound parameter. There is no escape hatch — `additionalProperties: false` is
   what makes that a fact rather than a convention, and test 27 is what proves it in CI.
3. **The two closed sets are validator parameters, not schema keywords.** `DatasetId` lives in `packages/db`
   and `PermissionCode` in `packages/contracts`; `packages/domain` imports nothing internal (§3.1). A schema
   also cannot know which slices have shipped, and hard-coding either set would fail every definition that a
   later slice's dataset serves. `validateReportDefinition(definition, { datasets, permissions })` therefore
   takes both as `ReadonlySet<string>` — 1A's `validatePolicy(definition, catalogue)` pattern.
4. **The module is derived, never asserted twice.** §4.16.1's grammar puts the module in the code's first
   segment; the validator refuses a `module` that disagrees. Two segments, so a report code can never be
   mistaken for a three-segment permission code.
5. **Every rejection names a JSON Pointer.** LEGACY-084's fix ("a human message naming the specific offending
   entity") applied to configuration: `ReportDefinitionValidation.errors[]` entries are `{ path, message }`
   with `path` a JSON Pointer into the rejected document, and §4.2.4 already lets `ERR_VALIDATION_FAILED`
   carry that array to the wire.

## Alternatives rejected

- **A TypeScript register of the forty §4.16.1 codes.** The card asks `validateReportDefinition` to enforce the
  code *grammar* and `DatasetId` *membership* — membership for the codes is §4.16.1's own table. A TS mirror
  would be a fourth spelling of a closed register (after §4.16.1, `ReportCodeSchema` and the seed directory
  layout), a merge hotspot 7B, 7C and 8D would each edit, and it would drag the ⚠️ `accounting.pdc_register`
  and `hr.leave_*` conditionals into a compiled constant. `REPORT_CODE_PATTERN` plus the seed loader's
  file-name check is the whole enforcement the format needs.
- **A SQL string in the definition, sandboxed by a parser.** This is LEGACY-036/037/069 with extra steps, and
  spec:97 forbids it outright.
```

- [ ] **Step 10: Commit**

```bash
git add packages/domain/report-definition.schema.json packages/domain/scripts/generate-report-type.ts \
        packages/domain/scripts/policy-type-options.ts packages/domain/src/reports packages/domain/src/index.ts \
        packages/domain/package.json packages/domain/test/reports \
        packages/contracts/test/report-filter-ops.test.ts docs/adr/0065-report-definition-format.md
git commit -m "$(cat <<'EOF'
feat(domain): add the ReportDefinition schema, type and validator [7A T4]

report-definition.schema.json ($id urn:dulja:report-definition:1) with
additionalProperties: false everywhere, the generated ReportDefinition type,
§4.16.1's two-segment code grammar, and validateReportDefinition taking the
DatasetId and permission sets as parameters (§3.1). ADR 0065 records why a
definition can never carry SQL text.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The dataset registry seam and the eight accounting datasets

This is the task test 27 exists for. §4.16.2 makes `packages/db/src/reports/datasets.ts` a **closed registry** in which every member is a named `withTenant` read query — "**never SQL text from a definition or a client**". §2.8's card fixes the boundary: **7A creates the file with every dataset whose source tables all exist at migration ≤ 0058, which is every dataset 7B needs, so 7B adds none and never edits the file**; 7C adds the three Phase 6 rows and 8D the six HR rows.

**The mechanism that makes "never SQL text" a fact rather than a promise.** A `DatasetColumn` does not carry a column *name*; it carries `ref: (tx: Sql) => SqlFragment`, a closure whose body is a literal tagged template authored in this file — `(tx) => tx\`l.account_id\``. A definition contributes a `field` string, which is looked up in the dataset's own `columns` array; a `field` that matches nothing is `ERR_VALIDATION_FAILED`, and a matching one yields the pre-authored fragment. No identifier, table name, operator or clause ever originates outside these three files. Values arrive as **bound parameters**, cast per column kind, and are shape-checked in TypeScript first so Postgres never has to raise `22P02` on a malformed uuid.

**Every date and timestamp leaves SQL as a string.** postgres.js parses `date` and `timestamptz` into JS `Date` objects, and a `Date` in a rendered report is a locale- and machine-dependent value — precisely the class of fragility LEGACY-069 describes on the input side. Every select list therefore emits `to_char(…)` with an explicit `at time zone 'UTC'` for timestamps, so a `DatasetRow` value is always `string | number | boolean | null` and never a `Date`. `numeric` columns come back from postgres.js as strings already, which is what keeps money out of a JS `number` (spec:2041).

**Files:**
- Create: `packages/db/src/reports/sql-fragment.ts`, `packages/db/src/reports/errors.ts`, `packages/db/src/reports/query.ts`, `packages/db/src/reports/datasets.ts`, `packages/db/src/reports/datasets/accounting.ts`, `packages/db/src/reports/index.ts`, `packages/db/test/reports/datasets.test.ts`
- Modify: `packages/db/src/index.ts`, `packages/contracts/src/errors.ts`, `apps/api/src/problem.ts`

**Interfaces:**
- Consumes: `Sql` from `postgres`; `REPORT_FILTER_OPS`, `ReportFilterOp` from `@dulja/domain` (Task 4); `withTenant` (test), `startDb` and `Seed` in the test file; `seedTenantV2`, `seedAccount`, `grantCodes` (§4.17); **`postJournal` and `JournalLine` from `tests/invariants/support/post-journal.ts`** (§4.17.1, 1B) — the test file posts its ledger rows through the shared helper, which drafts a JOURNAL and posts it through the real `postDocument` (§4.3.1). **This import is legal from `packages/db/test/**` because 3B's amendment A21(c) opened it** (3b:55, 3b:3333 — Task 7 Step 9 adds the third named `dependency-rule` allowance `packages/db/test/**` → `tests/invariants/support/**` and the `"../../tests/invariants/support/**/*.ts"` entry in `packages/db/tsconfig.json`), and 3B merges four phases before this slice starts. §4.17.1's closing paragraph still names two importers because round 3 left A21(c) to 3B's own PR; the head has three.

**Before Task 5, confirm A21(c) is on the head** — two greps, both of 3B's Task 7 Step 9 edits: `grep -n "packages/db/test" scripts/lint/rules/dependency-rule.ts` must show the allowance (its comment names §4.17.1 and A21(c)), and `grep -n "tests/invariants/support" packages/db/tsconfig.json` must show the `include` entry. If either is missing, **stop and raise it** rather than copying `postJournal`'s body into this file: a second spelling of the one helper that creates ledger rows is what hazard 9 forbids, and §4.17 assigns 7A exactly one `fixtures.ts` helper (`seedReportDefinition`), which is not this.
- Produces:

```ts
// packages/db/src/reports/sql-fragment.ts
import type { PendingQuery, Row } from "postgres";
/** What a postgres.js tagged template evaluates to before it is awaited. A fragment is composed INTO a larger
 *  tagged template (`tx\`select … ${fragment}\``); it is never concatenated as text (test 27, §3.3).
 *  If the installed postgres.js types export these names differently, alias them here — never fall back to a string. */
export type SqlFragment = PendingQuery<Row[]>;

// packages/db/src/reports/errors.ts
/** `packages/db` may not import `@dulja/contracts` (§3.1), so it cannot throw `AppError`. This is 1A's
 *  `PostingError` precedent (§4.2.4): a literal subset of `ErrCode`, never a new code. */
export type ReportErrorCode =
  | "ERR_REPORT_DATASET_UNKNOWN" | "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND" | "ERR_RBAC_FORBIDDEN";
export class ReportError extends Error { constructor(readonly code: ReportErrorCode, readonly detail: string) }

// packages/db/src/reports/query.ts
export type DatasetColumnKind = "text" | "uuid" | "date" | "timestamp" | "numeric" | "integer" | "boolean";
export interface DatasetColumn {
  readonly field: string;                     // what a ReportDefinition's filters / columns / groups / sort name
  readonly kind: DatasetColumnKind;
  readonly ref: (tx: Sql) => SqlFragment;     // the literal qualified column, authored in datasets/*.ts
  readonly filterable?: boolean;              // default true
  readonly sortable?: boolean;                // default true
}
export interface DatasetFilter { readonly field: string; readonly op: ReportFilterOp; readonly value: string | readonly string[] }
export interface DatasetSortKey { readonly field: string; readonly dir: "asc" | "desc" }
export interface DatasetParams {
  readonly companyId: string;
  readonly filters: readonly DatasetFilter[];
  readonly sort: readonly DatasetSortKey[];
  readonly limit: number;                     // clamped to MAX_DATASET_ROWS
  readonly offset: number;
}
export type DatasetRow = Readonly<Record<string, string | number | boolean | null>>;
export interface Dataset {
  readonly id: string;
  readonly columns: readonly DatasetColumn[];
  run(tx: Sql, params: DatasetParams): Promise<DatasetRow[]>;
}
export interface DatasetSpec {
  readonly id: string;
  readonly columns: readonly DatasetColumn[];
  readonly select: (tx: Sql) => SqlFragment;
  readonly from: (tx: Sql) => SqlFragment;
  /** null for a tenant-scoped source with no company key — `audit_log` is the only such member. */
  readonly company: ((tx: Sql, companyId: string) => SqlFragment) | null;
  readonly defaultOrder: (tx: Sql) => SqlFragment;
}
export const MAX_DATASET_ROWS = 100_000;
export function defineDataset(spec: DatasetSpec): Dataset;
/** `id` is the DATASET's id and defaults to `"unknown"`; `defineDataset` passes `spec.id`. It appears in every
 *  message these two raise — `filter field 'secret' is not a column of dataset 'ledger_entry'` — so a caller
 *  that omits it makes every such message read `'unknown'` and Step 1's assertions fail. */
export function datasetWhere(
  tx: Sql, columns: readonly DatasetColumn[], filters: readonly DatasetFilter[], id?: string,
): SqlFragment;
export function datasetOrderBy(
  tx: Sql, columns: readonly DatasetColumn[], sort: readonly DatasetSortKey[],
  fallback: (tx: Sql) => SqlFragment, id?: string,
): SqlFragment;

// packages/db/src/reports/datasets.ts — THE closed registry (§4.16.2)
export type DatasetId =
  // 7A — every source table exists at migration ≤ 0058
  | "ledger_entry" | "account_balance" | "account" | "document" | "document_line" | "document_event" | "audit_log"
  | "party" | "party_ageing" | "allocation" | "payment_term" | "bank_statement_line" | "bank_match" | "pdc"
  | "item" | "lot" | "warehouse" | "price_list_line" | "promotion"
  | "inventory_movement" | "stock_on_hand" | "cost_layer" | "cost_consumption" | "stock_valuation" | "item_profitability"
  | "tax_transaction";
  // 7C adds "shift" | "till_event" | "needs_attention"; 8D adds the six HR rows. No other slice edits this union.
export const DATASETS: Readonly<Record<DatasetId, Dataset>>;
export const DATASET_IDS: readonly DatasetId[];                  // Object.keys(DATASETS) in registry order
export function datasetFor(id: string): Dataset;                 // ReportError("ERR_REPORT_DATASET_UNKNOWN", …)
export function isDatasetId(id: string): id is DatasetId;

// packages/db/src/reports/datasets/accounting.ts — the eight this task ships
export const ledgerEntryDataset: Dataset;
export const accountBalanceDataset: Dataset;
export const accountDataset: Dataset;
export const documentDataset: Dataset;
export const documentLineDataset: Dataset;
export const documentEventDataset: Dataset;
export const auditLogDataset: Dataset;
export const taxTransactionDataset: Dataset;
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/reports/datasets.test.ts` — this file grows in Tasks 6 and 7; write the registry block and the accounting block now:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DATASETS, DATASET_IDS, datasetFor, isDatasetId, type DatasetId } from "../../src/reports/datasets";
import { MAX_DATASET_ROWS, type DatasetParams } from "../../src/reports/query";
import { ReportError } from "../../src/reports/errors";
// The one shared "post a real balanced journal" helper (§4.17.1, 1B). Reachable from `packages/db/test/**`
// through 3B's amendment A21(c) — the third named `dependency-rule` allowance plus the `packages/db`
// tsconfig `include` (3b:3333). Four dots: this file is packages/db/test/reports/, the target is repo-root
// tests/. `JournalLine` names the account field `account`, not `accountId`.
import { postJournal, type JournalLine } from "../../../../tests/invariants/support/post-journal";
import { grantCodes, seedAccount, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("the DatasetId registry — contracts §4.16.2", () => {
  it("holds exactly the twenty-six 7A members, in registry order", () => {
    expect([...DATASET_IDS]).toEqual([
      "ledger_entry", "account_balance", "account", "document", "document_line", "document_event", "audit_log",
      "party", "party_ageing", "allocation", "payment_term", "bank_statement_line", "bank_match", "pdc",
      "item", "lot", "warehouse", "price_list_line", "promotion",
      "inventory_movement", "stock_on_hand", "cost_layer", "cost_consumption", "stock_valuation", "item_profitability",
      "tax_transaction",
    ]);
    expect(Object.keys(DATASETS)).toEqual([...DATASET_IDS]);
  });

  it("every member's id matches its registry key and declares at least one column", () => {
    for (const id of DATASET_IDS) {
      expect(DATASETS[id]!.id, id).toBe(id);
      expect(DATASETS[id]!.columns.length, id).toBeGreaterThan(0);
    }
  });

  it("an unknown id is ERR_REPORT_DATASET_UNKNOWN, naming the id (§4.2.4)", () => {
    expect(isDatasetId("invoices")).toBe(false);
    try {
      datasetFor("invoices");
      expect.unreachable("an unknown dataset must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReportError);
      expect((e as ReportError).code).toBe("ERR_REPORT_DATASET_UNKNOWN");
      expect((e as ReportError).detail).toContain("'invoices'");
    }
  });

  it("no dataset file contains a template-literal or concatenated identifier (test 27, LEGACY-069)", () => {
    // The whole point of `ref: (tx) => tx`l.account_id`` is that no identifier can come from data. A `${` inside
    // a SQL-looking template that is NOT a bound value would defeat it, so the shape is asserted mechanically:
    // every `${…}` in these files interpolates either a fragment-returning call or a bound parameter name.
    for (const file of ["accounting.ts"]) {
      const text = readFileSync(
        fileURLToPath(new URL(`../../src/reports/datasets/${file}`, import.meta.url)), "utf8");
      expect(text, file).not.toMatch(/\$\{\s*(?:[a-zA-Z_$][\w$]*\s*\+|['"`])/);   // no concatenation, no literal splice
      expect(text, file).not.toMatch(/\.unsafe\s*\(/);                            // §3.3: three homes, none here
      expect(text, file).not.toMatch(/\bsql`/);                                   // only a `tx` may tag SQL (§3.7.5)
    }
  });
});

describe("the accounting datasets", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let cashId: string;
  let salesId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "datasets-a");
    b = await seedTenantV2(db, "datasets-b");
    await grantCodes(db, a, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    await grantCodes(db, b, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    cashId = await seedAccount(db, a, { code: "1000", nameEn: "Cash", type: "asset" });
    salesId = await seedAccount(db, a, { code: "4000", nameEn: "Sales", type: "income" });
    // `postJournal` drafts the JOURNAL and posts it through the REAL `postDocument` (§4.3.1) — from 1A
    // onward the only way a test creates ledger rows (§4.17.1). Its defaults are this fixture's: effective
    // date 2026-01-15 in `s.period`, currency MYR at rate 1, actor `s.human`. Nothing here writes
    // `ledger_entry` or `account_balance`, which `posting-only-tables` and spec:98 both require.
    const post = (s: Seed, lines: JournalLine[]) => postJournal(db, s, lines);
    await post(a, [{ account: cashId, debit: "120.0000" }, { account: salesId, credit: "120.0000" }]);
    await post(b, [
      { account: await seedAccount(db, b, { code: "1000", nameEn: "Cash", type: "asset" }), debit: "9.0000" },
      { account: await seedAccount(db, b, { code: "4000", nameEn: "Sales", type: "income" }), credit: "9.0000" },
    ]);
  });
  afterAll(async () => { await db.stop(); });

  const run = (s: Seed, id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      datasetFor(id).run(tx, { companyId: s.company, filters: [], sort: [], limit: 100, offset: 0, ...params }));

  it("ledger_entry returns the posted lines with every amount as a string and every date as YYYY-MM-DD", async () => {
    const rows = await run(a, "ledger_entry");
    expect(rows).toHaveLength(2);
    const cash = rows.find((r) => r["account_code"] === "1000")!;
    expect(cash["base_debit"]).toBe("120.0000");
    expect(typeof cash["base_debit"]).toBe("string");
    expect(cash["effective_date"]).toBe("2026-01-15");
    expect(cash["document_type_code"]).toBe("JOURNAL");
    expect(cash["account_type"]).toBe("asset");
    expect(cash["posted_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("account_balance returns the synchronous projection, never a re-aggregation", async () => {
    const rows = await run(a, "account_balance", { sort: [{ field: "account_code", dir: "asc" }] });
    expect(rows.map((r) => [r["account_code"], r["base_debit"], r["base_credit"]])).toEqual([
      ["1000", "120.0000", "0.0000"],
      ["4000", "0.0000", "120.0000"],
    ]);
  });

  it("filters bind values as parameters and refuse an undeclared field", async () => {
    const only = await run(a, "ledger_entry", { filters: [{ field: "account_id", op: "eq", value: cashId }] });
    expect(only).toHaveLength(1);
    expect(only[0]!["account_code"]).toBe("1000");

    const both = await run(a, "ledger_entry", { filters: [{ field: "account_id", op: "in", value: [cashId, salesId] }] });
    expect(both).toHaveLength(2);

    const range = await run(a, "ledger_entry", {
      filters: [{ field: "effective_date", op: "gte", value: "2026-01-16" }],
    });
    expect(range).toEqual([]);

    await expect(run(a, "ledger_entry", { filters: [{ field: "secret", op: "eq", value: "x" }] }))
      .rejects.toThrowError(/filter field 'secret' is not a column of dataset 'ledger_entry'/);
  });

  it("refuses a malformed value in TypeScript, before Postgres sees it", async () => {
    await expect(run(a, "ledger_entry", { filters: [{ field: "account_id", op: "eq", value: "not-a-uuid" }] }))
      .rejects.toThrowError(/value 'not-a-uuid' is not a uuid \(field 'account_id'\)/);
    await expect(run(a, "ledger_entry", { filters: [{ field: "effective_date", op: "eq", value: "15/01/2026" }] }))
      .rejects.toThrowError(/value '15\/01\/2026' is not a date \(field 'effective_date'\)/);
  });

  it("like is a prefix match and never a pattern (LEGACY-069's locale-fragile interpolation)", async () => {
    const hit = await run(a, "account", { filters: [{ field: "name_en", op: "like", value: "Ca" }] });
    expect(hit.map((r) => r["code"])).toEqual(["1000"]);
    const wild = await run(a, "account", { filters: [{ field: "name_en", op: "like", value: "%as" }] });
    expect(wild).toEqual([]);        // the % is escaped, so it matches a literal per-cent sign
  });

  it("refuses a sort on a column the dataset marks unsortable, and clamps the limit", async () => {
    await expect(run(a, "audit_log", { sort: [{ field: "before", dir: "asc" }] }))
      .rejects.toThrowError(/sort field 'before' is not sortable on dataset 'audit_log'/);
    const rows = await run(a, "ledger_entry", { limit: MAX_DATASET_ROWS + 1 });
    expect(rows).toHaveLength(2);    // clamped, not rejected — a definition cannot ask for unbounded rows
  });

  it("every accounting dataset is company-scoped except audit_log, which is tenant-scoped by design", async () => {
    for (const id of ["ledger_entry", "account_balance", "account", "document", "document_line",
                      "document_event", "tax_transaction"] as const) {
      const mine = await run(a, id);
      const theirs = await run(b, id);
      // Cross-tenant invisibility comes from RLS; the company predicate is the second, narrower gate.
      const otherCompany = await withTenant(db.rw, a.tenant, a.human, (tx) =>
        datasetFor(id).run(tx, { companyId: b.company, filters: [], sort: [], limit: 100, offset: 0 }));
      expect(otherCompany, id).toEqual([]);
      if (id === "ledger_entry") { expect(mine.length).toBe(2); expect(theirs.length).toBe(2); }
    }
    // app.audit_log has no company_id (plan0A:1920) — the accounting.audit_log report is the `auditor` view of
    // the whole tenant (spec:2163), gated by admin.audit_log.read, so the dataset declares company: null.
    const audit = await run(a, "audit_log", { filters: [{ field: "table_name", op: "eq", value: "account" }] });
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]!["table_name"]).toBe("account");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- reports/datasets`
Expected: FAIL — `Failed to resolve import "../../src/reports/datasets"`.

- [ ] **Step 3: Write the fragment type and the error class**

`packages/db/src/reports/sql-fragment.ts`:

```ts
import type { PendingQuery, Row } from "postgres";

/**
 * What a postgres.js tagged template evaluates to before it is awaited. Every dataset composes fragments into
 * one larger tagged template; nothing is ever concatenated as text (§3.3, test 27).
 *
 * If the installed postgres.js type declarations export these two names differently, alias them HERE — a
 * `string` return type would silently re-open LEGACY-036/037/069 and is not an acceptable fallback.
 */
export type SqlFragment = PendingQuery<Row[]>;
```

`packages/db/src/reports/errors.ts`:

```ts
/**
 * The report engine's error class. `AppError` lives in `@dulja/contracts` and 0B's `dependency-rule` pins
 * `packages/db` to `['@dulja/domain']` (§3.1), so this is 1A's `PostingError` precedent (§4.2.4) applied here:
 * a literal subset of `ErrCode`, never a new code. `apps/api/src/problem.ts` translates it in one branch.
 */
export type ReportErrorCode =
  | "ERR_REPORT_DATASET_UNKNOWN" | "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND" | "ERR_RBAC_FORBIDDEN";

export class ReportError extends Error {
  constructor(readonly code: ReportErrorCode, readonly detail: string) {
    super(detail);
    this.name = "ReportError";
  }
}
```

- [ ] **Step 4: Write the query compiler**

`packages/db/src/reports/query.ts`:

```ts
import type { Sql } from "postgres";
import { REPORT_FILTER_OPS, type ReportFilterOp } from "@dulja/domain";
import { ReportError } from "./errors";
import type { SqlFragment } from "./sql-fragment";

export type DatasetColumnKind = "text" | "uuid" | "date" | "timestamp" | "numeric" | "integer" | "boolean";

export interface DatasetColumn {
  readonly field: string;
  readonly kind: DatasetColumnKind;
  /** The literal qualified column, authored in `datasets/*.ts`. A definition supplies a `field`, never this. */
  readonly ref: (tx: Sql) => SqlFragment;
  readonly filterable?: boolean;
  readonly sortable?: boolean;
}

export interface DatasetFilter { readonly field: string; readonly op: ReportFilterOp; readonly value: string | readonly string[] }
export interface DatasetSortKey { readonly field: string; readonly dir: "asc" | "desc" }

export interface DatasetParams {
  readonly companyId: string;
  readonly filters: readonly DatasetFilter[];
  readonly sort: readonly DatasetSortKey[];
  readonly limit: number;
  readonly offset: number;
}

export type DatasetRow = Readonly<Record<string, string | number | boolean | null>>;

export interface Dataset {
  readonly id: string;
  readonly columns: readonly DatasetColumn[];
  run(tx: Sql, params: DatasetParams): Promise<DatasetRow[]>;
}

export interface DatasetSpec {
  readonly id: string;
  readonly columns: readonly DatasetColumn[];
  readonly select: (tx: Sql) => SqlFragment;
  readonly from: (tx: Sql) => SqlFragment;
  readonly company: ((tx: Sql, companyId: string) => SqlFragment) | null;
  readonly defaultOrder: (tx: Sql) => SqlFragment;
}

/** A definition cannot ask for unbounded rows; §4.9's report-generation SLO depends on a ceiling existing. */
export const MAX_DATASET_ROWS = 100_000;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const INTEGER = /^-?\d+$/;

/**
 * Shape-check a bound value BEFORE it reaches Postgres. Without this a malformed uuid raises SQLSTATE 22P02,
 * which `fromDatabaseError` maps to `ERR_INTERNAL` (§4.2.4) — a 500 for a caller's typo. LEGACY-084's fix is a
 * message naming the specific offending entity, which is what this produces.
 */
function assertValue(kind: DatasetColumnKind, value: string, field: string): void {
  const ok =
    kind === "uuid" ? UUID.test(value)
    : kind === "date" ? DATE.test(value)
    : kind === "timestamp" ? TIMESTAMP.test(value)
    : kind === "numeric" ? NUMERIC.test(value)
    : kind === "integer" ? INTEGER.test(value)
    : kind === "boolean" ? value === "true" || value === "false"
    : true;
  if (!ok) {
    throw new ReportError("ERR_VALIDATION_FAILED", `value '${value}' is not a ${kind} (field '${field}')`);
  }
}

/** `like` is a PREFIX match, never a pattern: the two LIKE metacharacters and the escape are neutralised. */
function likePrefix(value: string): string {
  return `${value.replace(/([\\%_])/g, "\\$1")}%`;
}

/** One bound scalar, cast per kind. Every cast below is literal text in this file. */
function scalar(tx: Sql, kind: DatasetColumnKind, value: string): SqlFragment {
  switch (kind) {
    case "uuid": return tx`${value}::uuid`;
    case "date": return tx`${value}::date`;
    case "timestamp": return tx`${value}::timestamptz`;
    case "numeric": return tx`${value}::numeric`;
    case "integer": return tx`${value}::int`;
    case "boolean": return tx`${value}::boolean`;
    case "text": return tx`${value}::text`;
  }
}

/** One bound array, cast per kind — postgres.js binds a JS array as an array parameter. */
function anyOf(tx: Sql, ref: SqlFragment, kind: DatasetColumnKind, values: readonly string[]): SqlFragment {
  switch (kind) {
    case "uuid": return tx`${ref} = any(${values as string[]}::uuid[])`;
    case "date": return tx`${ref} = any(${values as string[]}::date[])`;
    case "timestamp": return tx`${ref} = any(${values as string[]}::timestamptz[])`;
    case "numeric": return tx`${ref} = any(${values as string[]}::numeric[])`;
    case "integer": return tx`${ref} = any(${values as string[]}::int[])`;
    case "boolean": return tx`${ref} = any(${values as string[]}::boolean[])`;
    case "text": return tx`${ref} = any(${values as string[]}::text[])`;
  }
}

function columnOf(id: string, columns: readonly DatasetColumn[], field: string, purpose: "filter" | "sort"): DatasetColumn {
  const column = columns.find((c) => c.field === field);
  if (column === undefined) {
    throw new ReportError("ERR_VALIDATION_FAILED", `${purpose} field '${field}' is not a column of dataset '${id}'`);
  }
  if (purpose === "filter" && column.filterable === false) {
    throw new ReportError("ERR_VALIDATION_FAILED", `filter field '${field}' is not filterable on dataset '${id}'`);
  }
  if (purpose === "sort" && column.sortable === false) {
    throw new ReportError("ERR_VALIDATION_FAILED", `sort field '${field}' is not sortable on dataset '${id}'`);
  }
  return column;
}

export function datasetWhere(
  tx: Sql,
  columns: readonly DatasetColumn[],
  filters: readonly DatasetFilter[],
  id = "unknown",
): SqlFragment {
  let clause = tx``;
  for (const f of filters) {
    if (!REPORT_FILTER_OPS.includes(f.op)) {
      throw new ReportError("ERR_VALIDATION_FAILED", `filter operator '${f.op}' is not one of ${REPORT_FILTER_OPS.join(", ")}`);
    }
    const column = columnOf(id, columns, f.field, "filter");
    const ref = column.ref(tx);
    let predicate: SqlFragment;
    if (f.op === "in") {
      const values = Array.isArray(f.value) ? [...f.value] : String(f.value).split(",");
      if (values.length === 0) {
        throw new ReportError("ERR_VALIDATION_FAILED", `filter field '${f.field}' with op 'in' has no values`);
      }
      for (const v of values) assertValue(column.kind, v, column.field);
      predicate = anyOf(tx, ref, column.kind, values);
    } else if (f.op === "like") {
      predicate = tx`${ref}::text like ${likePrefix(String(f.value))}`;
    } else {
      const value = String(f.value);
      assertValue(column.kind, value, column.field);
      const bound = scalar(tx, column.kind, value);
      predicate =
        f.op === "eq" ? tx`${ref} = ${bound}`
        : f.op === "ne" ? tx`${ref} <> ${bound}`
        : f.op === "lt" ? tx`${ref} < ${bound}`
        : f.op === "lte" ? tx`${ref} <= ${bound}`
        : f.op === "gt" ? tx`${ref} > ${bound}`
        : tx`${ref} >= ${bound}`;
    }
    clause = tx`${clause} and ${predicate}`;
  }
  return clause;
}

export function datasetOrderBy(
  tx: Sql,
  columns: readonly DatasetColumn[],
  sort: readonly DatasetSortKey[],
  fallback: (tx: Sql) => SqlFragment,
  id = "unknown",
): SqlFragment {
  if (sort.length === 0) return fallback(tx);
  let clause = tx``;
  sort.forEach((key, i) => {
    const ref = columnOf(id, columns, key.field, "sort").ref(tx);
    // `asc` / `desc` are literal branches, so no direction token ever comes from data.
    const ordered = key.dir === "desc" ? tx`${ref} desc` : tx`${ref} asc`;
    clause = i === 0 ? ordered : tx`${clause}, ${ordered}`;
  });
  return clause;
}

/**
 * The one query shape every dataset shares. `select`, `from`, `company` and `defaultOrder` are literal
 * fragments authored in `datasets/*.ts`; `where`, `order by`, `limit` and `offset` are compiled from the
 * dataset's own declared columns. The statement runs on `tx` — a transaction from `withTenant`, so RLS is
 * already the outer gate (spec:2053) and the company predicate is the narrower, explicit one.
 */
export function defineDataset(spec: DatasetSpec): Dataset {
  return {
    id: spec.id,
    columns: spec.columns,
    async run(tx, params) {
      const limit = Math.min(Math.max(params.limit, 1), MAX_DATASET_ROWS);
      const offset = Math.max(params.offset, 0);
      const company = spec.company === null ? tx`true` : spec.company(tx, params.companyId);
      const where = datasetWhere(tx, spec.columns, params.filters, spec.id);
      const order = datasetOrderBy(tx, spec.columns, params.sort, spec.defaultOrder, spec.id);
      const rows = await tx<DatasetRow[]>`
        select ${spec.select(tx)}
          from ${spec.from(tx)}
         where ${company} ${where}
         order by ${order}
         limit ${limit} offset ${offset}`;
      return rows;
    },
  };
}
```

- [ ] **Step 5: Write the eight accounting datasets**

`packages/db/src/reports/datasets/accounting.ts`:

```ts
import { defineDataset, type Dataset, type DatasetColumn } from "../query";

/**
 * Every `ref` below is a literal tagged template. A ReportDefinition contributes a `field` STRING, which is
 * looked up in the `columns` array; the fragment it maps to was authored here (test 27, LEGACY-036/037/069).
 *
 * Every `date` is emitted as `to_char(x, 'YYYY-MM-DD')` and every `timestamptz` as
 * `to_char(x at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`, so a DatasetRow value is never a JS `Date`
 * and never depends on the session's TimeZone. `numeric` comes back from postgres.js as a string, which is
 * what keeps money out of a JS number (spec:2041).
 */

// ── ledger_entry — the immutable financial truth, joined to its document and account ────────────────
const LEDGER_ENTRY_COLUMNS: readonly DatasetColumn[] = [
  { field: "entry_id", kind: "uuid", ref: (tx) => tx`l.id` },
  { field: "account_id", kind: "uuid", ref: (tx) => tx`l.account_id` },
  { field: "account_code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "account_name_en", kind: "text", ref: (tx) => tx`ac.name_en` },
  { field: "account_name_ar", kind: "text", ref: (tx) => tx`ac.name_ar` },
  { field: "account_type", kind: "text", ref: (tx) => tx`ac.type::text` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`l.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`d.party_id` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`l.line_no` },
  { field: "currency", kind: "text", ref: (tx) => tx`l.currency` },
  { field: "exchange_rate", kind: "numeric", ref: (tx) => tx`l.exchange_rate` },
  { field: "debit", kind: "numeric", ref: (tx) => tx`l.debit` },
  { field: "credit", kind: "numeric", ref: (tx) => tx`l.credit` },
  { field: "base_debit", kind: "numeric", ref: (tx) => tx`l.base_debit` },
  { field: "base_credit", kind: "numeric", ref: (tx) => tx`l.base_credit` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`l.effective_date` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`l.fiscal_period_id` },
  // DERIVED, not stored. `app.fiscal_period` has no `code` column (spec:1657-1670 gives it `starts_on`,
  // `ends_on`, `status`, `closed_by`, `closed_at` and 1A's `reopen_reason` and nothing else), and the
  // period labels the 0A fixtures describe - "2026-01 open, 2026-02 closed" - are exactly this
  // expression. Three datasets expose the same label the same way, so a reader never has to wonder
  // whether two reports mean the same period; a filter on it is a text filter over the expression, which
  // is why the `ref` closure and not a bare column name is what a filter composes against.
  { field: "fiscal_period_code", kind: "text", ref: (tx) => tx`to_char(fp.starts_on, 'YYYY-MM')` },
  { field: "posting_seq", kind: "integer", ref: (tx) => tx`d.posting_seq` },
  { field: "posted_at", kind: "timestamp", ref: (tx) => tx`l.posted_at` },
];

export const ledgerEntryDataset: Dataset = defineDataset({
  id: "ledger_entry",
  columns: LEDGER_ENTRY_COLUMNS,
  company: (tx, companyId) => tx`l.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.ledger_entry l
        join app.account       ac on ac.id = l.account_id
        join app.document      d  on d.id  = l.document_id
        join app.document_type dt on dt.id = d.document_type_id
        join app.fiscal_period fp on fp.id = l.fiscal_period_id
        join app.dimension_value bv on bv.id = d.branch_id`,
  select: (tx) => tx`l.id                          as entry_id,
         l.account_id                              as account_id,
         ac.code                                   as account_code,
         ac.name_en                                as account_name_en,
         ac.name_ar                                as account_name_ar,
         ac.type::text                             as account_type,
         l.document_id                             as document_id,
         dt.code                                   as document_type_code,
         d.series                                  as series,
         d.number::int                             as number,
         d.branch_id                               as branch_id,
         bv.code                                   as branch_code,
         d.party_id                                as party_id,
         l.line_no                                 as line_no,
         l.currency                                as currency,
         l.exchange_rate                           as exchange_rate,
         l.debit                                   as debit,
         l.credit                                  as credit,
         l.base_debit                              as base_debit,
         l.base_credit                             as base_credit,
         to_char(l.effective_date, 'YYYY-MM-DD')   as effective_date,
         l.fiscal_period_id                        as fiscal_period_id,
         to_char(fp.starts_on, 'YYYY-MM')          as fiscal_period_code,
         d.posting_seq::int                        as posting_seq,
         to_char(l.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at`,
  // The chronological key of §4.3.5, so a ledger read is in posting order by default.
  defaultOrder: (tx) => tx`l.effective_date asc, d.posting_seq asc, l.line_no asc`,
});

// ── account_balance — the SYNCHRONOUS projection; never a re-aggregation of ledger_entry ────────────
const ACCOUNT_BALANCE_COLUMNS: readonly DatasetColumn[] = [
  { field: "account_id", kind: "uuid", ref: (tx) => tx`b.account_id` },
  { field: "account_code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "account_name_en", kind: "text", ref: (tx) => tx`ac.name_en` },
  { field: "account_name_ar", kind: "text", ref: (tx) => tx`ac.name_ar` },
  { field: "account_type", kind: "text", ref: (tx) => tx`ac.type::text` },
  { field: "is_group", kind: "boolean", ref: (tx) => tx`ac.is_group` },
  { field: "parent_id", kind: "uuid", ref: (tx) => tx`ac.parent_id` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`b.fiscal_period_id` },
  { field: "fiscal_period_code", kind: "text", ref: (tx) => tx`to_char(fp.starts_on, 'YYYY-MM')` },
  { field: "currency", kind: "text", ref: (tx) => tx`b.currency` },
  { field: "debit", kind: "numeric", ref: (tx) => tx`b.debit` },
  { field: "credit", kind: "numeric", ref: (tx) => tx`b.credit` },
  { field: "base_debit", kind: "numeric", ref: (tx) => tx`b.base_debit` },
  { field: "base_credit", kind: "numeric", ref: (tx) => tx`b.base_credit` },
  { field: "base_balance", kind: "numeric", ref: (tx) => tx`(b.base_debit - b.base_credit)` },
];

export const accountBalanceDataset: Dataset = defineDataset({
  id: "account_balance",
  columns: ACCOUNT_BALANCE_COLUMNS,
  company: (tx, companyId) => tx`b.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.account_balance b
        join app.account       ac on ac.id = b.account_id
        join app.fiscal_period fp on fp.id = b.fiscal_period_id`,
  select: (tx) => tx`b.account_id                  as account_id,
         ac.code                                   as account_code,
         ac.name_en                                as account_name_en,
         ac.name_ar                                as account_name_ar,
         ac.type::text                             as account_type,
         ac.is_group                               as is_group,
         ac.parent_id                              as parent_id,
         b.fiscal_period_id                        as fiscal_period_id,
         to_char(fp.starts_on, 'YYYY-MM')          as fiscal_period_code,
         b.currency                                as currency,
         b.debit                                   as debit,
         b.credit                                  as credit,
         b.base_debit                              as base_debit,
         b.base_credit                             as base_credit,
         (b.base_debit - b.base_credit)            as base_balance`,
  defaultOrder: (tx) => tx`ac.code asc, b.currency asc`,
});

// ── account — the chart of accounts ──────────────────────────────────────────────────────────────────
const ACCOUNT_COLUMNS: readonly DatasetColumn[] = [
  { field: "account_id", kind: "uuid", ref: (tx) => tx`ac.id` },
  { field: "code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`ac.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`ac.name_ar` },
  { field: "account_type", kind: "text", ref: (tx) => tx`ac.type::text` },
  { field: "parent_id", kind: "uuid", ref: (tx) => tx`ac.parent_id` },
  { field: "parent_code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "is_group", kind: "boolean", ref: (tx) => tx`ac.is_group` },
  { field: "currency", kind: "text", ref: (tx) => tx`ac.currency` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`ac.archived_at` },
];

export const accountDataset: Dataset = defineDataset({
  id: "account",
  columns: ACCOUNT_COLUMNS,
  company: (tx, companyId) => tx`ac.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.account ac left join app.account p on p.id = ac.parent_id`,
  select: (tx) => tx`ac.id as account_id, ac.code as code, ac.name_en as name_en, ac.name_ar as name_ar,
         ac.type::text as account_type, ac.parent_id as parent_id, p.code as parent_code,
         ac.is_group as is_group, ac.currency as currency,
         to_char(ac.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`ac.code asc`,
});

// ── document — the header register, one definition covering every §4.14 type ─────────────────────────
const DOCUMENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "document_id", kind: "uuid", ref: (tx) => tx`d.id` },
  { field: "document_type_id", kind: "uuid", ref: (tx) => tx`d.document_type_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "document_type_module", kind: "text", ref: (tx) => tx`dt.module` },
  { field: "status", kind: "text", ref: (tx) => tx`d.status::text` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`d.effective_date` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`d.fiscal_period_id` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`d.party_id` },
  { field: "party_code", kind: "text", ref: (tx) => tx`pt.code` },
  { field: "party_name_en", kind: "text", ref: (tx) => tx`pt.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "currency", kind: "text", ref: (tx) => tx`d.currency` },
  { field: "exchange_rate", kind: "numeric", ref: (tx) => tx`d.exchange_rate` },
  { field: "rate_source", kind: "text", ref: (tx) => tx`d.rate_source` },
  { field: "posting_seq", kind: "integer", ref: (tx) => tx`d.posting_seq` },
  { field: "posted_at", kind: "timestamp", ref: (tx) => tx`d.posted_at` },
  { field: "created_at", kind: "timestamp", ref: (tx) => tx`d.created_at` },
  { field: "reverses_document_id", kind: "uuid", ref: (tx) => tx`d.reverses_document_id` },
  { field: "base_total", kind: "numeric", ref: (tx) => tx`coalesce(t.base_total, 0)` },
];

export const documentDataset: Dataset = defineDataset({
  id: "document",
  columns: DOCUMENT_COLUMNS,
  company: (tx, companyId) => tx`d.company_id = ${companyId}::uuid`,
  // The total is Σ base debit of the document's own ledger lines — read from the ledger, never recomputed
  // from the lines' amounts (spec:2041 "stored base amounts are never recomputed on read").
  from: (tx) => tx`app.document d
        join app.document_type dt on dt.id = d.document_type_id
        join app.dimension_value bv on bv.id = d.branch_id
        left join app.party pt on pt.id = d.party_id
        left join (select le.document_id, sum(le.base_debit) as base_total
                     from app.ledger_entry le group by le.document_id) t on t.document_id = d.id`,
  select: (tx) => tx`d.id as document_id, d.document_type_id as document_type_id, dt.code as document_type_code,
         dt.module as document_type_module, d.status::text as status, d.series as series, d.number::int as number,
         to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, d.fiscal_period_id as fiscal_period_id,
         d.party_id as party_id, pt.code as party_code, pt.name_en as party_name_en,
         d.branch_id as branch_id, bv.code as branch_code, d.currency as currency,
         d.exchange_rate as exchange_rate, d.rate_source as rate_source, d.posting_seq::int as posting_seq,
         to_char(d.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at,
         to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
         d.reverses_document_id as reverses_document_id, coalesce(t.base_total, 0) as base_total`,
  defaultOrder: (tx) => tx`d.effective_date desc, d.series asc, d.number desc nulls last`,
});

// ── document_line — the generic line, every §4.3.4 column a report can read ──────────────────────────
const DOCUMENT_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "line_id", kind: "uuid", ref: (tx) => tx`dl.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`dl.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "status", kind: "text", ref: (tx) => tx`d.status::text` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`d.effective_date` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`dl.line_no` },
  { field: "kind", kind: "text", ref: (tx) => tx`dl.kind` },
  { field: "description", kind: "text", ref: (tx) => tx`dl.description` },
  { field: "account_id", kind: "uuid", ref: (tx) => tx`dl.account_id` },
  { field: "account_code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`dl.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`dl.warehouse_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`dl.lot_id` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`dl.quantity` },
  { field: "unit_price", kind: "numeric", ref: (tx) => tx`dl.unit_price` },
  { field: "discount", kind: "numeric", ref: (tx) => tx`dl.discount` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`dl.amount` },
  { field: "tax_code_id", kind: "uuid", ref: (tx) => tx`dl.tax_code_id` },
  { field: "tax_amount", kind: "numeric", ref: (tx) => tx`dl.tax_amount` },
  { field: "total_incl_tax", kind: "numeric", ref: (tx) => tx`dl.total_incl_tax` },
  { field: "cost", kind: "numeric", ref: (tx) => tx`dl.cost` },
  { field: "debit", kind: "numeric", ref: (tx) => tx`dl.debit` },
  { field: "credit", kind: "numeric", ref: (tx) => tx`dl.credit` },
];

export const documentLineDataset: Dataset = defineDataset({
  id: "document_line",
  columns: DOCUMENT_LINE_COLUMNS,
  company: (tx, companyId) => tx`dl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.document_line dl
        join app.document      d  on d.id  = dl.document_id
        join app.document_type dt on dt.id = d.document_type_id
        left join app.account ac on ac.id = dl.account_id
        left join app.item    it on it.id = dl.item_id`,
  select: (tx) => tx`dl.id as line_id, dl.document_id as document_id, dt.code as document_type_code,
         d.status::text as status, to_char(d.effective_date, 'YYYY-MM-DD') as effective_date,
         d.branch_id as branch_id, dl.line_no as line_no, dl.kind as kind, dl.description as description,
         dl.account_id as account_id, ac.code as account_code, dl.item_id as item_id, it.code as item_code,
         it.name_en as item_name_en, dl.warehouse_id as warehouse_id, dl.lot_id as lot_id,
         dl.quantity as quantity, dl.unit_price as unit_price, dl.discount as discount, dl.amount as amount,
         dl.tax_code_id as tax_code_id, dl.tax_amount as tax_amount, dl.total_incl_tax as total_incl_tax,
         dl.cost as cost, dl.debit as debit, dl.credit as credit`,
  defaultOrder: (tx) => tx`d.effective_date desc, dl.document_id asc, dl.line_no asc`,
});

// ── document_event — the auditor's view of every transition and override (spec:2163) ─────────────────
const DOCUMENT_EVENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "event_id", kind: "uuid", ref: (tx) => tx`de.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`de.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "event_kind", kind: "text", ref: (tx) => tx`de.event_kind` },
  { field: "from_status", kind: "text", ref: (tx) => tx`de.from_status::text` },
  { field: "to_status", kind: "text", ref: (tx) => tx`de.to_status::text` },
  { field: "override_code", kind: "text", ref: (tx) => tx`de.override_code` },
  { field: "actor_id", kind: "uuid", ref: (tx) => tx`de.actor_id` },
  { field: "actor_display_name", kind: "text", ref: (tx) => tx`ap.display_name` },
  { field: "attributed_to", kind: "uuid", ref: (tx) => tx`de.attributed_to` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`de.occurred_at` },
  { field: "reason", kind: "text", ref: (tx) => tx`de.reason` },
];

export const documentEventDataset: Dataset = defineDataset({
  id: "document_event",
  columns: DOCUMENT_EVENT_COLUMNS,
  company: (tx, companyId) => tx`de.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.document_event de
        join app.document      d  on d.id  = de.document_id
        join app.document_type dt on dt.id = d.document_type_id
        join app.principal     ap on ap.id = de.actor_id`,
  select: (tx) => tx`de.id as event_id, de.document_id as document_id, dt.code as document_type_code,
         d.series as series, d.number::int as number, de.event_kind as event_kind,
         de.from_status::text as from_status, de.to_status::text as to_status,
         de.override_code as override_code, de.actor_id as actor_id, ap.display_name as actor_display_name,
         de.attributed_to as attributed_to,
         to_char(de.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
         de.reason as reason`,
  defaultOrder: (tx) => tx`de.occurred_at desc, de.id desc`,
});

// ── audit_log — TENANT-scoped: app.audit_log has no company_id (plan0A:1920) ─────────────────────────
const AUDIT_LOG_COLUMNS: readonly DatasetColumn[] = [
  { field: "seq", kind: "integer", ref: (tx) => tx`al.seq` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`al.occurred_at` },
  { field: "table_name", kind: "text", ref: (tx) => tx`al.table_name` },
  { field: "row_id", kind: "text", ref: (tx) => tx`al.row_id` },
  { field: "action", kind: "text", ref: (tx) => tx`al.action` },
  { field: "actor_id", kind: "uuid", ref: (tx) => tx`al.actor_id` },
  { field: "actor_display_name", kind: "text", ref: (tx) => tx`ap.display_name` },
  { field: "actor_kind", kind: "text", ref: (tx) => tx`ap.kind::text` },
  // The before/after images are visible but neither filterable nor sortable: a jsonb comparison in a WHERE is
  // not indexable (LEGACY-070) and a filter over a before-image is a search over historical PII by another name.
  { field: "before", kind: "text", ref: (tx) => tx`al.before::text`, filterable: false, sortable: false },
  { field: "after", kind: "text", ref: (tx) => tx`al.after::text`, filterable: false, sortable: false },
];

export const auditLogDataset: Dataset = defineDataset({
  id: "audit_log",
  columns: AUDIT_LOG_COLUMNS,
  company: null,
  from: (tx) => tx`app.audit_log al join app.principal ap on ap.id = al.actor_id`,
  select: (tx) => tx`al.seq::int as seq,
         to_char(al.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
         al.table_name as table_name, al.row_id as row_id, al.action as action,
         al.actor_id as actor_id, ap.display_name as actor_display_name, ap.kind::text as actor_kind,
         al.before::text as before, al.after::text as after`,
  defaultOrder: (tx) => tx`al.seq desc`,
});

// ── tax_transaction — written only by the posting service; append-only (§4.9.2) ──────────────────────
const TAX_TRANSACTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "transaction_id", kind: "uuid", ref: (tx) => tx`tt.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`tt.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`d.party_id` },
  { field: "party_tax_registration", kind: "text", ref: (tx) => tx`pt.tax_registration` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`tt.line_no` },
  { field: "tax_code_id", kind: "uuid", ref: (tx) => tx`tt.tax_code_id` },
  { field: "tax_code", kind: "text", ref: (tx) => tx`tc.code` },
  { field: "tax_code_kind", kind: "text", ref: (tx) => tx`tc.kind` },
  { field: "tax_rate", kind: "numeric", ref: (tx) => tx`tc.rate` },
  { field: "regime_id", kind: "uuid", ref: (tx) => tx`tt.regime_id` },
  { field: "regime_code", kind: "text", ref: (tx) => tx`tr.code` },
  { field: "base", kind: "numeric", ref: (tx) => tx`tt.base` },
  { field: "tax", kind: "numeric", ref: (tx) => tx`tt.tax` },
  { field: "base_base", kind: "numeric", ref: (tx) => tx`tt.base_base` },
  { field: "tax_base", kind: "numeric", ref: (tx) => tx`tt.tax_base` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`tt.effective_date` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`tt.fiscal_period_id` },
];

export const taxTransactionDataset: Dataset = defineDataset({
  id: "tax_transaction",
  columns: TAX_TRANSACTION_COLUMNS,
  company: (tx, companyId) => tx`tt.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.tax_transaction tt
        join app.document      d  on d.id  = tt.document_id
        join app.document_type dt on dt.id = d.document_type_id
        join app.tax_code      tc on tc.id = tt.tax_code_id
        join app.tax_regime    tr on tr.id = tt.regime_id
        left join app.party    pt on pt.id = d.party_id`,
  select: (tx) => tx`tt.id as transaction_id, tt.document_id as document_id, dt.code as document_type_code,
         d.series as series, d.number::int as number, d.party_id as party_id,
         pt.tax_registration as party_tax_registration, tt.line_no as line_no,
         tt.tax_code_id as tax_code_id, tc.code as tax_code, tc.kind as tax_code_kind, tc.rate as tax_rate,
         tt.regime_id as regime_id, tr.code as regime_code,
         tt.base as base, tt.tax as tax, tt.base_base as base_base, tt.tax_base as tax_base,
         to_char(tt.effective_date, 'YYYY-MM-DD') as effective_date, tt.fiscal_period_id as fiscal_period_id`,
  defaultOrder: (tx) => tx`tt.effective_date asc, tt.document_id asc, tt.line_no asc`,
});
```

- [ ] **Step 6: Write the registry and the barrel**

`packages/db/src/reports/datasets.ts`:

```ts
import { ReportError } from "./errors";
import type { Dataset } from "./query";
import {
  accountBalanceDataset, accountDataset, auditLogDataset, documentDataset, documentEventDataset,
  documentLineDataset, ledgerEntryDataset, taxTransactionDataset,
} from "./datasets/accounting";

/**
 * THE closed registry of contracts §4.16.2. Every member is a named `withTenant` read query; a definition
 * names an id and never contributes SQL (test 27). Membership is pre-declared in §4.16.2 in the form of
 * §3.5.3, which is what stops three slices editing this file in parallel:
 *
 *   7A (this file, at creation) — every dataset whose source tables all exist at migration <= 0058, which is
 *                                 every dataset 7B needs. **7B adds none and never edits this file.**
 *   7C — "shift" | "till_event" | "needs_attention" (Phase 6 tables, migrations 0059-0073)
 *   8D — "employee" | "attendance_event" | "payroll_line" | "employee_ytd" | "statutory_schedule" | "leave_record"
 *
 * A dataset for a table §4.16.2 does not name is added to that section FIRST.
 */
export type DatasetId =
  | "ledger_entry" | "account_balance" | "account" | "document" | "document_line" | "document_event" | "audit_log"
  | "party" | "party_ageing" | "allocation" | "payment_term" | "bank_statement_line" | "bank_match" | "pdc"
  | "item" | "lot" | "warehouse" | "price_list_line" | "promotion"
  | "inventory_movement" | "stock_on_hand" | "cost_layer" | "cost_consumption" | "stock_valuation" | "item_profitability"
  | "tax_transaction";

export const DATASETS: Readonly<Record<DatasetId, Dataset>> = {
  ledger_entry: ledgerEntryDataset,
  account_balance: accountBalanceDataset,
  account: accountDataset,
  document: documentDataset,
  document_line: documentLineDataset,
  document_event: documentEventDataset,
  audit_log: auditLogDataset,
  // Task 6 fills the seven AR/AP members and Task 7 the eleven inventory members. Until then this object does
  // not satisfy `Record<DatasetId, Dataset>` and `bun run typecheck` says so, by design: a partially filled
  // registry must not compile, because `datasetFor` would return undefined for a declared id.
  tax_transaction: taxTransactionDataset,
};

export const DATASET_IDS: readonly DatasetId[] = Object.keys(DATASETS) as DatasetId[];

export function isDatasetId(id: string): id is DatasetId {
  return Object.prototype.hasOwnProperty.call(DATASETS, id);
}

export function datasetFor(id: string): Dataset {
  if (!isDatasetId(id)) {
    throw new ReportError(
      "ERR_REPORT_DATASET_UNKNOWN",
      `dataset '${id}' is not a member of the closed registry; the members are ${DATASET_IDS.join(", ")}`,
    );
  }
  return DATASETS[id];
}
```

`packages/db/src/reports/index.ts`:

```ts
export { ReportError, type ReportErrorCode } from "./errors";
export type { SqlFragment } from "./sql-fragment";
export {
  MAX_DATASET_ROWS, datasetOrderBy, datasetWhere, defineDataset,
  type Dataset, type DatasetColumn, type DatasetColumnKind, type DatasetFilter,
  type DatasetParams, type DatasetRow, type DatasetSortKey, type DatasetSpec,
} from "./query";
export { DATASETS, DATASET_IDS, datasetFor, isDatasetId, type DatasetId } from "./datasets";
```

Add `export * from "./reports";` to `packages/db/src/index.ts`. **1B's two report modules keep their existing direct exports** — `trialBalance`, `trialBalanceFingerprint`, `accountLedger` and `accountOpeningBalance` are not moved into this barrel, because 7B re-expresses 1B's reports over exactly those import paths.

- [ ] **Step 7: Add the error row and the `problem.ts` branch**

In `packages/contracts/src/errors.ts`, add the row the allocated space of §4.2.4 reserves for this slice:

```ts
  ERR_REPORT_DATASET_UNKNOWN: {
    status: 422,
    title: "Unknown report dataset",
    remedy: "Name a dataset from the registry the error lists, or ask for the report definition to be corrected.",
  },
```

In `apps/api/src/problem.ts`, add **one** `asAppError` branch beside the existing `TenantContextError`, `PostingError` and `PolicyEvaluationError` branches:

```ts
  // packages/db and packages/domain cannot import AppError (§3.1), so their error classes carry the code and
  // are translated here. `ReportDefinitionError.errors` reaches the wire because §4.2.4 lets
  // ERR_VALIDATION_FAILED carry JSON-Pointer entries.
  if (e instanceof ReportError) return new AppError(e.code, e.detail);
  if (e instanceof ReportDefinitionError) return new AppError(e.code, e.message, { errors: [...e.errors] });
```

- [ ] **Step 8: Run the test to see it pass**

Run: `bun run --cwd packages/db test -- reports/datasets`
Expected: **the registry `describe` still FAILS** on its first two `it`s — `DATASET_IDS` has eight members, not twenty-six — and the accounting `describe` PASSES in full. That is the intended state at the end of this task: Tasks 6 and 7 fill the remaining eighteen members and the registry assertions turn green there. Record the expected failure in the commit body.

Run: `bun run lint:rules && bun run typecheck`
Expected: `lint:rules` green for `no-bare-db`, `no-sql-concat` and `posting-only-tables`; `typecheck` **red** on `DATASETS` not satisfying `Record<DatasetId, Dataset>` — the deliberate compile error the registry comment describes, cleared in Task 7.

- [ ] **Step 9: Commit**

**Tasks 5, 6 and 7 are ONE pull request** — three commits on one branch, merged together. The registry is a
`Record<DatasetId, Dataset>` over a closed union, so it cannot compile until Task 7 adds the last member;
merging Task 5 on its own would put a red `typecheck` on the shared head, which Global Constraints forbids.
The known-red note below is a within-branch state, not a merged one.

```bash
git add packages/db/src/reports/sql-fragment.ts packages/db/src/reports/errors.ts \
        packages/db/src/reports/query.ts packages/db/src/reports/datasets.ts \
        packages/db/src/reports/datasets/accounting.ts packages/db/src/reports/index.ts \
        packages/db/src/index.ts packages/db/test/reports/datasets.test.ts \
        packages/contracts/src/errors.ts apps/api/src/problem.ts
git commit -m "$(cat <<'EOF'
feat(db): add the dataset registry seam and the eight accounting datasets [7A T5]

A DatasetColumn carries a literal SqlFragment closure, not a column name, so a
ReportDefinition contributes only a `field` string and no identifier, operator or
clause can originate outside datasets/*.ts (test 27, LEGACY-036/037/069). Values are
bound parameters, shape-checked in TypeScript first; every date and timestamp
leaves SQL as a string so no JS Date or locale reaches a rendered report.

Known-red until T7: DATASETS does not yet satisfy Record<DatasetId, Dataset>, and
the two registry-membership assertions expect all twenty-six members. T6 adds the
seven AR/AP datasets, T7 the eleven inventory datasets.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The seven AR/AP datasets

`party`, `party_ageing`, `allocation`, `payment_term`, `bank_statement_line`, `bank_match` and ⚠️ `pdc` — the datasets 7C's AR/AP catalogue and 7B's party-facing reports read. Every source table exists at migration ≤ 0052 (4B's range), so all seven belong to 7A by §4.16.2's rule.

**The one conditional in this task, stated mechanically.** `app.pdc` is 4B's migration **0051**, which exists only if **OD-09** (post-dated cheques) was answered *yes*; §4.16.2 says the `pdc` id and the `accounting.pdc_register` report that reads it "are dropped together, so the union never names a table that does not exist". OD-09 is **4B's** gate, not this slice's, so this is not an owner-decision task — it is a two-line consequence, recorded here so an implementer does not discover it at `bun run test`:

> **If `packages/db/migrations/0051_create_pdc.sql` is absent from the merged head:** delete the `| "pdc"` member from `DatasetId`, the `pdc:` entry from `DATASETS`, the `pdcDataset` export and its `describe` block below, and drop `"pdc"` from the twenty-six-member assertion in `datasets.test.ts` (leaving twenty-five). Nothing else in this plan changes — no other task reads the id.

Verify before writing: `ls packages/db/migrations/0051_*.sql` — a hit means the table shipped and the dataset stays.

**Files:**
- Create: `packages/db/src/reports/datasets/ar-ap.ts`
- Modify: `packages/db/src/reports/datasets.ts`, `packages/db/test/reports/datasets.test.ts`

**Interfaces:**
- Consumes: `defineDataset`, `Dataset`, `DatasetColumn` from `../query` (Task 5); `seedParty`, `seedPaymentTerm`, `seedAccount`, `seedTenantV2`, `grantCodes` (§4.17).
- Produces:

```ts
// packages/db/src/reports/datasets/ar-ap.ts
export const partyDataset: Dataset;
export const partyAgeingDataset: Dataset;
export const allocationDataset: Dataset;
export const paymentTermDataset: Dataset;
export const bankStatementLineDataset: Dataset;
export const bankMatchDataset: Dataset;
export const pdcDataset: Dataset;            // ⚠️ present only if 4B's migration 0051 shipped (OD-09)
```

- [ ] **Step 1: Write the failing test**

Append a `describe` to `packages/db/test/reports/datasets.test.ts`:

```ts
describe("the AR/AP datasets", () => {
  let db: Db;
  let s: Seed;
  let receivableId: string;
  let customerId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "datasets-arap");
    await grantCodes(db, s, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    receivableId = await seedAccount(db, s, { code: "1200", nameEn: "Trade receivables", type: "asset" });
    await seedAccount(db, s, { code: "2100", nameEn: "Trade payables", type: "liability" });
    customerId = await seedParty(db, s, { kind: "customer", code: "C001", receivableAccountId: receivableId });
    await seedPaymentTerm(db, s, { code: "NET30", dueDays: 30 });
  });
  afterAll(async () => { await db.stop(); });

  const run = (id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      datasetFor(id).run(tx, { companyId: s.company, filters: [], sort: [], limit: 100, offset: 0, ...params }));

  it("party returns the customer with its control accounts resolved to codes", async () => {
    const rows = await run("party", { filters: [{ field: "kind", op: "eq", value: "customer" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!["code"]).toBe("C001");
    expect(rows[0]!["receivable_account_code"]).toBe("1200");
    expect(rows[0]!["archived_at"]).toBeNull();
  });

  it("payment_term returns due_days as an integer, not a string", async () => {
    const rows = await run("payment_term");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["code"]).toBe("NET30");
    expect(rows[0]!["due_days"]).toBe(30);
  });

  it("party_ageing, allocation, bank_statement_line and bank_match are empty but queryable", async () => {
    for (const id of ["party_ageing", "allocation", "bank_statement_line", "bank_match"]) {
      expect(await run(id), id).toEqual([]);
    }
  });

  it("party_ageing accepts a bucket filter over its closed vocabulary", async () => {
    expect(await run("party_ageing", { filters: [{ field: "bucket", op: "in", value: ["current", "1_30"] }] }))
      .toEqual([]);
  });

  it("every AR/AP dataset declares party_id or a party join, so the statement reports can group by party", () => {
    for (const id of ["party", "party_ageing", "allocation"]) {
      const fields = datasetFor(id).columns.map((c) => c.field);
      expect(fields, id).toContain("party_id");
    }
  });

  // ⚠️ OD-09. Delete this `it` together with the dataset if 4B's migration 0051 is absent.
  it("pdc returns the register with its maturity date as a string", async () => {
    expect(await run("pdc", { filters: [{ field: "status", op: "eq", value: "in_hand" }] })).toEqual([]);
    expect(datasetFor("pdc").columns.map((c) => c.field)).toContain("maturity_date");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- reports/datasets`
Expected: FAIL — the first `it` throws `ReportError: dataset 'party' is not a member of the closed registry`.

- [ ] **Step 3: Write the seven datasets**

`packages/db/src/reports/datasets/ar-ap.ts`:

```ts
import { defineDataset, type Dataset, type DatasetColumn } from "../query";

// ── party — customers and vendors (§4.5.7); 4A's credit columns included ────────────────────────────
const PARTY_COLUMNS: readonly DatasetColumn[] = [
  { field: "party_id", kind: "uuid", ref: (tx) => tx`p.id` },
  { field: "kind", kind: "text", ref: (tx) => tx`p.kind` },
  { field: "code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`p.name_ar` },
  { field: "currency", kind: "text", ref: (tx) => tx`p.currency` },
  { field: "tax_registration", kind: "text", ref: (tx) => tx`p.tax_registration` },
  { field: "email", kind: "text", ref: (tx) => tx`p.email` },
  { field: "phone", kind: "text", ref: (tx) => tx`p.phone` },
  { field: "receivable_account_id", kind: "uuid", ref: (tx) => tx`p.receivable_account_id` },
  { field: "receivable_account_code", kind: "text", ref: (tx) => tx`ra.code` },
  { field: "payable_account_id", kind: "uuid", ref: (tx) => tx`p.payable_account_id` },
  { field: "payable_account_code", kind: "text", ref: (tx) => tx`pa.code` },
  { field: "credit_limit", kind: "numeric", ref: (tx) => tx`p.credit_limit` },
  { field: "credit_hold", kind: "boolean", ref: (tx) => tx`p.credit_hold` },
  { field: "payment_term_id", kind: "uuid", ref: (tx) => tx`p.payment_term_id` },
  { field: "payment_term_code", kind: "text", ref: (tx) => tx`ptm.code` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`p.archived_at` },
];

export const partyDataset: Dataset = defineDataset({
  id: "party",
  columns: PARTY_COLUMNS,
  company: (tx, companyId) => tx`p.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.party p
        left join app.account      ra  on ra.id  = p.receivable_account_id
        left join app.account      pa  on pa.id  = p.payable_account_id
        left join app.payment_term ptm on ptm.id = p.payment_term_id`,
  select: (tx) => tx`p.id as party_id, p.kind as kind, p.code as code, p.name_en as name_en, p.name_ar as name_ar,
         p.currency as currency, p.tax_registration as tax_registration, p.email as email, p.phone as phone,
         p.receivable_account_id as receivable_account_id, ra.code as receivable_account_code,
         p.payable_account_id as payable_account_id, pa.code as payable_account_code,
         p.credit_limit as credit_limit, p.credit_hold as credit_hold,
         p.payment_term_id as payment_term_id, ptm.code as payment_term_code,
         to_char(p.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`p.kind asc, p.code asc`,
});

// ── party_ageing — 4B's ASYNC projection, rebuilt nightly; never recomputed here (spec:1204) ─────────
const PARTY_AGEING_COLUMNS: readonly DatasetColumn[] = [
  { field: "party_id", kind: "uuid", ref: (tx) => tx`pa.party_id` },
  { field: "party_code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "party_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "party_kind", kind: "text", ref: (tx) => tx`p.kind` },
  { field: "currency", kind: "text", ref: (tx) => tx`pa.currency` },
  { field: "as_of", kind: "date", ref: (tx) => tx`pa.as_of` },
  { field: "bucket", kind: "text", ref: (tx) => tx`pa.bucket` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`pa.amount` },
  { field: "base_amount", kind: "numeric", ref: (tx) => tx`pa.base_amount` },
];

export const partyAgeingDataset: Dataset = defineDataset({
  id: "party_ageing",
  columns: PARTY_AGEING_COLUMNS,
  company: (tx, companyId) => tx`pa.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.party_ageing pa join app.party p on p.id = pa.party_id`,
  select: (tx) => tx`pa.party_id as party_id, p.code as party_code, p.name_en as party_name_en, p.kind as party_kind,
         pa.currency as currency, to_char(pa.as_of, 'YYYY-MM-DD') as as_of, pa.bucket as bucket,
         pa.amount as amount, pa.base_amount as base_amount`,
  // The bucket order the ageing report prints in is the projection's own vocabulary order, not alphabetical.
  defaultOrder: (tx) => tx`p.code asc, pa.currency asc,
         array_position(array['current','1_30','31_60','61_90','over_90'], pa.bucket) asc`,
});

// ── allocation — which settlement paid which document (§4.8.1) ──────────────────────────────────────
const ALLOCATION_COLUMNS: readonly DatasetColumn[] = [
  { field: "allocation_id", kind: "uuid", ref: (tx) => tx`al.id` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`al.party_id` },
  { field: "party_code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "settlement_document_id", kind: "uuid", ref: (tx) => tx`al.settlement_document_id` },
  { field: "settlement_type_code", kind: "text", ref: (tx) => tx`st.code` },
  { field: "settlement_number", kind: "integer", ref: (tx) => tx`sd.number` },
  { field: "settled_document_id", kind: "uuid", ref: (tx) => tx`al.settled_document_id` },
  { field: "settled_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "settled_number", kind: "integer", ref: (tx) => tx`dd.number` },
  { field: "settled_effective_date", kind: "date", ref: (tx) => tx`dd.effective_date` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`al.amount` },
  { field: "base_amount", kind: "numeric", ref: (tx) => tx`al.base_amount` },
  { field: "fx_difference", kind: "numeric", ref: (tx) => tx`al.fx_difference` },
  { field: "unallocated_at", kind: "timestamp", ref: (tx) => tx`al.unallocated_at` },
  { field: "created_at", kind: "timestamp", ref: (tx) => tx`al.created_at` },
];

export const allocationDataset: Dataset = defineDataset({
  id: "allocation",
  columns: ALLOCATION_COLUMNS,
  company: (tx, companyId) => tx`al.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.allocation al
        join app.party         p  on p.id  = al.party_id
        join app.document      sd on sd.id = al.settlement_document_id
        join app.document_type st on st.id = sd.document_type_id
        join app.document      dd on dd.id = al.settled_document_id
        join app.document_type dt on dt.id = dd.document_type_id`,
  select: (tx) => tx`al.id as allocation_id, al.party_id as party_id, p.code as party_code,
         al.settlement_document_id as settlement_document_id, st.code as settlement_type_code,
         sd.number::int as settlement_number, al.settled_document_id as settled_document_id,
         dt.code as settled_type_code, dd.number::int as settled_number,
         to_char(dd.effective_date, 'YYYY-MM-DD') as settled_effective_date,
         al.amount as amount, al.base_amount as base_amount, al.fx_difference as fx_difference,
         to_char(al.unallocated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as unallocated_at,
         to_char(al.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`,
  defaultOrder: (tx) => tx`al.created_at desc`,
});

// ── payment_term ────────────────────────────────────────────────────────────────────────────────────
const PAYMENT_TERM_COLUMNS: readonly DatasetColumn[] = [
  { field: "payment_term_id", kind: "uuid", ref: (tx) => tx`ptm.id` },
  { field: "code", kind: "text", ref: (tx) => tx`ptm.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`ptm.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`ptm.name_ar` },
  { field: "due_days", kind: "integer", ref: (tx) => tx`ptm.due_days` },
  { field: "discount_days", kind: "integer", ref: (tx) => tx`ptm.discount_days` },
  { field: "discount_pct", kind: "numeric", ref: (tx) => tx`ptm.discount_pct` },
];

export const paymentTermDataset: Dataset = defineDataset({
  id: "payment_term",
  columns: PAYMENT_TERM_COLUMNS,
  company: (tx, companyId) => tx`ptm.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.payment_term ptm`,
  select: (tx) => tx`ptm.id as payment_term_id, ptm.code as code, ptm.name_en as name_en, ptm.name_ar as name_ar,
         ptm.due_days as due_days, ptm.discount_days as discount_days, ptm.discount_pct as discount_pct`,
  defaultOrder: (tx) => tx`ptm.due_days asc, ptm.code asc`,
});

// ── bank_statement_line — the imported statement (§4.8.3) ───────────────────────────────────────────
const BANK_STATEMENT_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "line_id", kind: "uuid", ref: (tx) => tx`bl.id` },
  { field: "statement_id", kind: "uuid", ref: (tx) => tx`bl.statement_id` },
  { field: "statement_date", kind: "date", ref: (tx) => tx`bs.statement_date` },
  { field: "bank_account_id", kind: "uuid", ref: (tx) => tx`bs.bank_account_id` },
  { field: "bank_account_code", kind: "text", ref: (tx) => tx`ba.code` },
  { field: "currency", kind: "text", ref: (tx) => tx`bs.currency` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`bl.line_no` },
  { field: "value_date", kind: "date", ref: (tx) => tx`bl.value_date` },
  { field: "description", kind: "text", ref: (tx) => tx`bl.description` },
  { field: "reference", kind: "text", ref: (tx) => tx`bl.reference` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`bl.amount` },
  // The "unreconciled items" report is exactly this predicate, so it is a column and not a hand-written report.
  { field: "matched_amount", kind: "numeric", ref: (tx) => tx`coalesce(m.matched, 0)` },
  { field: "is_matched", kind: "boolean", ref: (tx) => tx`coalesce(m.matched, 0) = bl.amount` },
];

export const bankStatementLineDataset: Dataset = defineDataset({
  id: "bank_statement_line",
  columns: BANK_STATEMENT_LINE_COLUMNS,
  company: (tx, companyId) => tx`bl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.bank_statement_line bl
        join app.bank_statement bs on bs.id = bl.statement_id
        join app.account        ba on ba.id = bs.bank_account_id
        left join (select bm.statement_line_id, sum(bm.amount) as matched
                     from app.bank_match bm where bm.unmatched_at is null
                    group by bm.statement_line_id) m on m.statement_line_id = bl.id`,
  select: (tx) => tx`bl.id as line_id, bl.statement_id as statement_id,
         to_char(bs.statement_date, 'YYYY-MM-DD') as statement_date,
         bs.bank_account_id as bank_account_id, ba.code as bank_account_code, bs.currency as currency,
         bl.line_no as line_no, to_char(bl.value_date, 'YYYY-MM-DD') as value_date,
         bl.description as description, bl.reference as reference, bl.amount as amount,
         coalesce(m.matched, 0) as matched_amount, (coalesce(m.matched, 0) = bl.amount) as is_matched`,
  defaultOrder: (tx) => tx`bs.statement_date asc, bl.line_no asc`,
});

// ── bank_match — the reconciliation trail; never alters a ledger entry (spec:2457) ───────────────────
const BANK_MATCH_COLUMNS: readonly DatasetColumn[] = [
  { field: "match_id", kind: "uuid", ref: (tx) => tx`bm.id` },
  { field: "statement_line_id", kind: "uuid", ref: (tx) => tx`bm.statement_line_id` },
  { field: "value_date", kind: "date", ref: (tx) => tx`bl.value_date` },
  { field: "bank_account_id", kind: "uuid", ref: (tx) => tx`bs.bank_account_id` },
  { field: "reconcilable_kind", kind: "text", ref: (tx) => tx`bm.reconcilable_kind` },
  { field: "reconcilable_document_id", kind: "uuid", ref: (tx) => tx`bm.reconcilable_document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "document_number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`bm.amount` },
  { field: "matched_at", kind: "timestamp", ref: (tx) => tx`bm.matched_at` },
  { field: "unmatched_at", kind: "timestamp", ref: (tx) => tx`bm.unmatched_at` },
];

export const bankMatchDataset: Dataset = defineDataset({
  id: "bank_match",
  columns: BANK_MATCH_COLUMNS,
  company: (tx, companyId) => tx`bm.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.bank_match bm
        join app.bank_statement_line bl on bl.id = bm.statement_line_id
        join app.bank_statement      bs on bs.id = bl.statement_id
        join app.document           d   on d.id  = bm.reconcilable_document_id
        join app.document_type      dt  on dt.id = d.document_type_id`,
  select: (tx) => tx`bm.id as match_id, bm.statement_line_id as statement_line_id,
         to_char(bl.value_date, 'YYYY-MM-DD') as value_date, bs.bank_account_id as bank_account_id,
         bm.reconcilable_kind as reconcilable_kind, bm.reconcilable_document_id as reconcilable_document_id,
         dt.code as document_type_code, d.number::int as document_number, bm.amount as amount,
         to_char(bm.matched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as matched_at,
         to_char(bm.unmatched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as unmatched_at`,
  defaultOrder: (tx) => tx`bm.matched_at desc`,
});

// ── pdc ⚠️ — present only if 4B's migration 0051 shipped (OD-09). Delete with the DatasetId member. ──
const PDC_COLUMNS: readonly DatasetColumn[] = [
  { field: "pdc_id", kind: "uuid", ref: (tx) => tx`pd.id` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`pd.party_id` },
  { field: "party_code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "receipt_document_id", kind: "uuid", ref: (tx) => tx`pd.receipt_document_id` },
  { field: "deposit_document_id", kind: "uuid", ref: (tx) => tx`pd.deposit_document_id` },
  { field: "cheque_number", kind: "text", ref: (tx) => tx`pd.cheque_number` },
  { field: "bank_name", kind: "text", ref: (tx) => tx`pd.bank_name` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`pd.amount` },
  { field: "currency", kind: "text", ref: (tx) => tx`pd.currency` },
  { field: "maturity_date", kind: "date", ref: (tx) => tx`pd.maturity_date` },
  { field: "status", kind: "text", ref: (tx) => tx`pd.status` },
];

export const pdcDataset: Dataset = defineDataset({
  id: "pdc",
  columns: PDC_COLUMNS,
  company: (tx, companyId) => tx`pd.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.pdc pd join app.party p on p.id = pd.party_id`,
  select: (tx) => tx`pd.id as pdc_id, pd.party_id as party_id, p.code as party_code,
         pd.receipt_document_id as receipt_document_id, pd.deposit_document_id as deposit_document_id,
         pd.cheque_number as cheque_number, pd.bank_name as bank_name, pd.amount as amount,
         pd.currency as currency, to_char(pd.maturity_date, 'YYYY-MM-DD') as maturity_date, pd.status as status`,
  defaultOrder: (tx) => tx`pd.maturity_date asc, pd.cheque_number asc`,
});
```

- [ ] **Step 4: Register the seven**

In `packages/db/src/reports/datasets.ts`, add the import and the seven entries between `audit_log` and `tax_transaction`, so `DATASET_IDS` stays in §4.16.2's declared order:

```ts
import {
  allocationDataset, bankMatchDataset, bankStatementLineDataset, partyAgeingDataset, partyDataset,
  paymentTermDataset, pdcDataset,
} from "./datasets/ar-ap";
// … inside DATASETS, after `audit_log:` and before the inventory block Task 7 adds:
  party: partyDataset,
  party_ageing: partyAgeingDataset,
  allocation: allocationDataset,
  payment_term: paymentTermDataset,
  bank_statement_line: bankStatementLineDataset,
  bank_match: bankMatchDataset,
  pdc: pdcDataset,                    // ⚠️ OD-09 — drop with the DatasetId member if migration 0051 is absent
```

- [ ] **Step 5: Run the test to see it pass**

Run: `bun run --cwd packages/db test -- reports/datasets`
Expected: the AR/AP `describe` PASSES in full; the registry `describe`'s two membership `it`s still fail (fifteen members of twenty-six). `bun run typecheck` is still red on `Record<DatasetId, Dataset>` — Task 7 clears both.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/reports/datasets/ar-ap.ts packages/db/src/reports/datasets.ts \
        packages/db/test/reports/datasets.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add the seven AR/AP datasets [7A T6]

party, party_ageing, allocation, payment_term, bank_statement_line, bank_match
and pdc. party_ageing reads 4B's async projection and never recomputes it
(spec:1204); bank_statement_line exposes matched_amount and is_matched as
columns, so 7C's unreconciled-items report is a filter and not a second query.

pdc is conditional on OD-09 (4B's gate): if migration 0051 is absent, drop the
DatasetId member, the registry entry, the export and its test block.

Known-red until T7: DATASETS has fifteen of twenty-six members.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The eleven inventory datasets, and the registry closes

`item`, `lot`, `warehouse`, `price_list_line`, `promotion`, `inventory_movement`, `stock_on_hand`, `cost_layer`, `cost_consumption`, `stock_valuation` and `item_profitability` — every source table exists at migration ≤ 0048. With these the registry has all twenty-six 7A members, `DATASETS` satisfies `Record<DatasetId, Dataset>`, and both the membership assertions and `bun run typecheck` go green.

**Two rules from §3.4 and hazard 22 these datasets obey literally.** Stock **ageing** and stock **valuation** read `cost_layer` / `cost_consumption` / `stock_valuation` and **never recompute a cost** (spec:1222, 1228; LEGACY-055) — the datasets expose the layer columns and 7B's definition groups them; nothing here divides a value by a quantity. And `item_profitability` is 4B's async projection: the dataset reads it and never re-derives revenue or margin (§4.6.1, test 7's revenue-bearing re-run in 7B).

**Files:**
- Create: `packages/db/src/reports/datasets/inventory.ts`
- Modify: `packages/db/src/reports/datasets.ts`, `packages/db/test/reports/datasets.test.ts`

**Interfaces:**
- Consumes: `defineDataset`, `Dataset`, `DatasetColumn` from `../query` (Task 5); `seedItem`, `seedUnit`, `seedWarehouse`, `seedLot`, `seedPriceList`, `seedBranch`, `seedTenantV2`, `grantCodes` (§4.17).
- Produces:

```ts
// packages/db/src/reports/datasets/inventory.ts
export const itemDataset: Dataset;
export const lotDataset: Dataset;
export const warehouseDataset: Dataset;
export const priceListLineDataset: Dataset;
export const promotionDataset: Dataset;
export const inventoryMovementDataset: Dataset;
export const stockOnHandDataset: Dataset;
export const costLayerDataset: Dataset;
export const costConsumptionDataset: Dataset;
export const stockValuationDataset: Dataset;
export const itemProfitabilityDataset: Dataset;
```

- [ ] **Step 1: Write the failing test**

Append a `describe` to `packages/db/test/reports/datasets.test.ts`:

```ts
describe("the inventory datasets", () => {
  let db: Db;
  let s: Seed;
  let itemId: string;
  let baseUnitId: string;
  let warehouseId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "datasets-inv");
    await grantCodes(db, s, { codes: ["inventory.stock.read", "inventory.cost.read"] });
    const item = await seedItem(db, s, { code: "ITEM-1" });
    itemId = item.itemId;
    baseUnitId = item.baseUnitId;
    warehouseId = await seedWarehouse(db, s, { code: "WH-1" });
    await seedLot(db, s, { itemId, code: "L-1", expiresOn: "2027-06-30" });
    await seedPriceList(db, s, { code: "PL-1", lines: [{ itemId, unitId: baseUnitId, unitPrice: "12.5000" }] });
  });
  afterAll(async () => { await db.stop(); });

  const run = (id: DatasetId, params: Partial<DatasetParams> = {}) =>
    withTenant(db.rw, s.tenant, s.human, (tx) =>
      datasetFor(id).run(tx, { companyId: s.company, filters: [], sort: [], limit: 100, offset: 0, ...params }));

  it("item returns the master row with its four account columns", async () => {
    const rows = await run("item", { filters: [{ field: "code", op: "eq", value: "ITEM-1" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!["kind"]).toBe("product");
    expect(rows[0]!["base_unit_code"]).not.toBeNull();
    for (const f of ["revenue_account_code", "inventory_account_code", "cogs_account_code", "expense_account_code"]) {
      expect(Object.keys(rows[0]!), f).toContain(f);
    }
  });

  it("lot carries expires_on as YYYY-MM-DD and a days_to_expiry integer for the expiry list", async () => {
    const rows = await run("lot", { filters: [{ field: "item_id", op: "eq", value: itemId }] });
    const dated = rows.find((r) => r["code"] === "L-1")!;
    expect(dated["expires_on"]).toBe("2027-06-30");
    expect(typeof dated["days_to_expiry"]).toBe("number");
  });

  it("warehouse exposes kind and branch_id, so a transfer register can group by both", async () => {
    const rows = await run("warehouse", { filters: [{ field: "code", op: "eq", value: "WH-1" }] });
    expect(rows[0]!["kind"]).toBe("stock");
    expect(rows[0]!["branch_id"]).not.toBeNull();
  });

  it("price_list_line joins its list for the company predicate and keeps the price a string", async () => {
    const rows = await run("price_list_line");
    expect(rows).toHaveLength(1);
    expect(rows[0]!["unit_price"]).toBe("12.5000");
    expect(rows[0]!["price_list_code"]).toBe("PL-1");
  });

  it("the six movement and cost datasets are queryable and empty before any posting", async () => {
    for (const id of ["inventory_movement", "stock_on_hand", "cost_layer", "cost_consumption",
                      "stock_valuation", "item_profitability", "promotion"]) {
      expect(await run(id), id).toEqual([]);
    }
  });

  it("cost_layer exposes unit_cost and qty_remaining and computes NO cost of its own (LEGACY-055)", () => {
    const fields = datasetFor("cost_layer").columns.map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(["unit_cost", "qty_in", "qty_remaining", "effective_at", "sequence"]));
    const text = readFileSync(
      fileURLToPath(new URL("../../src/reports/datasets/inventory.ts", import.meta.url)), "utf8");
    // A division inside a cost dataset would be a recomputed unit cost — the defect LEGACY-055 and spec:1228 forbid.
    expect(text).not.toMatch(/\bvalue\s*\/\s*quantity\b/);
    expect(text).not.toMatch(/\bsum\(\s*\w+\.value\s*\)\s*\/\s*/);
  });

  it("stock_valuation and item_profitability are read, never re-derived (spec:1204)", () => {
    expect(datasetFor("stock_valuation").columns.map((c) => c.field))
      .toEqual(expect.arrayContaining(["as_of", "quantity", "value"]));
    expect(datasetFor("item_profitability").columns.map((c) => c.field))
      .toEqual(expect.arrayContaining(["revenue_base", "cogs_base", "margin_base", "quantity_sold"]));
  });
});
```

And turn the two registry assertions green by leaving them exactly as Task 5 wrote them — they now expect the set this task completes.

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- reports/datasets`
Expected: FAIL — `ReportError: dataset 'item' is not a member of the closed registry`.

- [ ] **Step 3: Write the eleven datasets**

`packages/db/src/reports/datasets/inventory.ts`:

```ts
import { defineDataset, type Dataset, type DatasetColumn } from "../query";

// ── item — the master row plus the four account columns the policy resolves through (§4.6.1) ─────────
const ITEM_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`it.id` },
  { field: "code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`it.name_ar` },
  { field: "kind", kind: "text", ref: (tx) => tx`it.kind` },
  { field: "barcode", kind: "text", ref: (tx) => tx`it.barcode` },
  { field: "base_unit_id", kind: "uuid", ref: (tx) => tx`it.base_unit_id` },
  { field: "base_unit_code", kind: "text", ref: (tx) => tx`u.code` },
  { field: "track_lots", kind: "boolean", ref: (tx) => tx`it.track_lots` },
  { field: "shelf_life_days", kind: "integer", ref: (tx) => tx`it.shelf_life_days` },
  { field: "revenue_account_code", kind: "text", ref: (tx) => tx`ra.code` },
  { field: "inventory_account_code", kind: "text", ref: (tx) => tx`ia.code` },
  { field: "cogs_account_code", kind: "text", ref: (tx) => tx`ca.code` },
  { field: "expense_account_code", kind: "text", ref: (tx) => tx`ea.code` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`it.archived_at` },
];

export const itemDataset: Dataset = defineDataset({
  id: "item",
  columns: ITEM_COLUMNS,
  company: (tx, companyId) => tx`it.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.item it
        join app.unit_of_measure u on u.id = it.base_unit_id
        left join app.account ra on ra.id = it.revenue_account_id
        left join app.account ia on ia.id = it.inventory_account_id
        left join app.account ca on ca.id = it.cogs_account_id
        left join app.account ea on ea.id = it.expense_account_id`,
  select: (tx) => tx`it.id as item_id, it.code as code, it.name_en as name_en, it.name_ar as name_ar,
         it.kind as kind, it.barcode as barcode, it.base_unit_id as base_unit_id, u.code as base_unit_code,
         it.track_lots as track_lots, it.shelf_life_days as shelf_life_days,
         ra.code as revenue_account_code, ia.code as inventory_account_code,
         ca.code as cogs_account_code, ea.code as expense_account_code,
         to_char(it.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`it.code asc`,
});

// ── lot — with the derived days_to_expiry the expiry list sorts on ──────────────────────────────────
const LOT_COLUMNS: readonly DatasetColumn[] = [
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`l.id` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`l.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "code", kind: "text", ref: (tx) => tx`l.code` },
  { field: "expires_on", kind: "date", ref: (tx) => tx`l.expires_on` },
  { field: "manufactured_on", kind: "date", ref: (tx) => tx`l.manufactured_on` },
  // current_date is the render date, not the accounting date — this column is a shelf-life warning and is
  // never a figure a report ties to the ledger with (spec:2039 keeps effective_date the accounting date).
  { field: "days_to_expiry", kind: "integer", ref: (tx) => tx`(l.expires_on - current_date)` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`l.archived_at` },
];

export const lotDataset: Dataset = defineDataset({
  id: "lot",
  columns: LOT_COLUMNS,
  company: (tx, companyId) => tx`l.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.lot l join app.item it on it.id = l.item_id`,
  select: (tx) => tx`l.id as lot_id, l.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         l.code as code, to_char(l.expires_on, 'YYYY-MM-DD') as expires_on,
         to_char(l.manufactured_on, 'YYYY-MM-DD') as manufactured_on,
         (l.expires_on - current_date)::int as days_to_expiry,
         to_char(l.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`l.expires_on asc nulls last, it.code asc, l.code asc`,
});

// ── warehouse ───────────────────────────────────────────────────────────────────────────────────────
const WAREHOUSE_COLUMNS: readonly DatasetColumn[] = [
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`w.id` },
  { field: "code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`w.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`w.name_ar` },
  { field: "kind", kind: "text", ref: (tx) => tx`w.kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "parent_id", kind: "uuid", ref: (tx) => tx`w.parent_id` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`w.archived_at` },
];

export const warehouseDataset: Dataset = defineDataset({
  id: "warehouse",
  columns: WAREHOUSE_COLUMNS,
  company: (tx, companyId) => tx`w.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.warehouse w join app.dimension_value bv on bv.id = w.branch_id`,
  select: (tx) => tx`w.id as warehouse_id, w.code as code, w.name_en as name_en, w.name_ar as name_ar,
         w.kind as kind, w.branch_id as branch_id, bv.code as branch_code, w.parent_id as parent_id,
         to_char(w.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`w.code asc`,
});

// ── price_list_line — the company key lives on price_list, so the join is the predicate's source ─────
const PRICE_LIST_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "line_id", kind: "uuid", ref: (tx) => tx`pll.id` },
  { field: "price_list_id", kind: "uuid", ref: (tx) => tx`pll.price_list_id` },
  { field: "price_list_code", kind: "text", ref: (tx) => tx`pl.code` },
  { field: "price_list_currency", kind: "text", ref: (tx) => tx`pl.currency` },
  { field: "customer_kind", kind: "text", ref: (tx) => tx`pl.customer_kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`pl.branch_id` },
  { field: "valid_from", kind: "date", ref: (tx) => tx`pl.valid_from` },
  { field: "valid_to", kind: "date", ref: (tx) => tx`pl.valid_to` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`pll.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "unit_id", kind: "uuid", ref: (tx) => tx`pll.unit_id` },
  { field: "unit_code", kind: "text", ref: (tx) => tx`u.code` },
  { field: "min_quantity", kind: "numeric", ref: (tx) => tx`pll.min_quantity` },
  { field: "unit_price", kind: "numeric", ref: (tx) => tx`pll.unit_price` },
];

export const priceListLineDataset: Dataset = defineDataset({
  id: "price_list_line",
  columns: PRICE_LIST_LINE_COLUMNS,
  company: (tx, companyId) => tx`pl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.price_list_line pll
        join app.price_list pl on pl.id = pll.price_list_id
        join app.item       it on it.id = pll.item_id
        left join app.unit_of_measure u on u.id = pll.unit_id`,
  select: (tx) => tx`pll.id as line_id, pll.price_list_id as price_list_id, pl.code as price_list_code,
         pl.currency as price_list_currency, pl.customer_kind as customer_kind, pl.branch_id as branch_id,
         to_char(pl.valid_from, 'YYYY-MM-DD') as valid_from, to_char(pl.valid_to, 'YYYY-MM-DD') as valid_to,
         pll.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         pll.unit_id as unit_id, u.code as unit_code, pll.min_quantity as min_quantity,
         pll.unit_price as unit_price`,
  defaultOrder: (tx) => tx`pl.code asc, it.code asc, pll.min_quantity asc`,
});

// ── promotion ───────────────────────────────────────────────────────────────────────────────────────
const PROMOTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "promotion_id", kind: "uuid", ref: (tx) => tx`pr.id` },
  { field: "code", kind: "text", ref: (tx) => tx`pr.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`pr.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`pr.name_ar` },
  { field: "kind", kind: "text", ref: (tx) => tx`pr.kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`pr.branch_id` },
  { field: "starts_at", kind: "timestamp", ref: (tx) => tx`pr.starts_at` },
  { field: "ends_at", kind: "timestamp", ref: (tx) => tx`pr.ends_at` },
  { field: "definition", kind: "text", ref: (tx) => tx`pr.definition::text`, filterable: false, sortable: false },
];

export const promotionDataset: Dataset = defineDataset({
  id: "promotion",
  columns: PROMOTION_COLUMNS,
  company: (tx, companyId) => tx`pr.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.promotion pr`,
  select: (tx) => tx`pr.id as promotion_id, pr.code as code, pr.name_en as name_en, pr.name_ar as name_ar,
         pr.kind as kind, pr.branch_id as branch_id,
         to_char(pr.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as starts_at,
         to_char(pr.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ends_at,
         pr.definition::text as definition`,
  defaultOrder: (tx) => tx`pr.starts_at desc nulls last, pr.code asc`,
});

// ── inventory_movement — append-only, signed; the movement register (§4.7.3) ─────────────────────────
const INVENTORY_MOVEMENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "movement_id", kind: "uuid", ref: (tx) => tx`m.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`m.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "document_number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`m.line_no` },
  { field: "movement_no", kind: "integer", ref: (tx) => tx`m.movement_no` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`m.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`m.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`m.lot_id` },
  { field: "lot_code", kind: "text", ref: (tx) => tx`lo.code` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`m.quantity` },
  { field: "value", kind: "numeric", ref: (tx) => tx`m.value` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`m.effective_date` },
  { field: "posting_seq", kind: "integer", ref: (tx) => tx`m.posting_seq` },
  { field: "posted_at", kind: "timestamp", ref: (tx) => tx`m.posted_at` },
];

export const inventoryMovementDataset: Dataset = defineDataset({
  id: "inventory_movement",
  columns: INVENTORY_MOVEMENT_COLUMNS,
  company: (tx, companyId) => tx`m.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.inventory_movement m
        join app.document      d  on d.id  = m.document_id
        join app.document_type dt on dt.id = d.document_type_id
        join app.item          it on it.id = m.item_id
        join app.warehouse     w  on w.id  = m.warehouse_id
        join app.lot           lo on lo.id = m.lot_id`,
  select: (tx) => tx`m.id as movement_id, m.document_id as document_id, dt.code as document_type_code,
         d.number::int as document_number, m.line_no as line_no, m.movement_no as movement_no,
         m.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         m.warehouse_id as warehouse_id, w.code as warehouse_code, w.branch_id as branch_id,
         m.lot_id as lot_id, lo.code as lot_code, m.quantity as quantity, m.value as value,
         to_char(m.effective_date, 'YYYY-MM-DD') as effective_date, m.posting_seq::int as posting_seq,
         to_char(m.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at`,
  // The total chronological key of spec:1225 / §4.3.5, so a movement register reads in costing order.
  defaultOrder: (tx) => tx`m.effective_date asc, m.posting_seq asc, m.line_no asc, m.movement_no asc`,
});

// ── stock_on_hand — the SYNCHRONOUS projection (D14); the minimal-set report 3D re-expresses ─────────
const STOCK_ON_HAND_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`h.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "item_name_ar", kind: "text", ref: (tx) => tx`it.name_ar` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`h.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "warehouse_kind", kind: "text", ref: (tx) => tx`w.kind` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`h.lot_id` },
  { field: "lot_code", kind: "text", ref: (tx) => tx`lo.code` },
  { field: "expires_on", kind: "date", ref: (tx) => tx`lo.expires_on` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`h.quantity` },
  { field: "base_unit_code", kind: "text", ref: (tx) => tx`u.code` },
];

export const stockOnHandDataset: Dataset = defineDataset({
  id: "stock_on_hand",
  columns: STOCK_ON_HAND_COLUMNS,
  company: (tx, companyId) => tx`h.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.stock_on_hand h
        join app.item      it on it.id = h.item_id
        join app.warehouse w  on w.id  = h.warehouse_id
        join app.lot       lo on lo.id = h.lot_id
        join app.unit_of_measure u on u.id = it.base_unit_id`,
  select: (tx) => tx`h.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         it.name_ar as item_name_ar, h.warehouse_id as warehouse_id, w.code as warehouse_code,
         w.kind as warehouse_kind, w.branch_id as branch_id, h.lot_id as lot_id, lo.code as lot_code,
         to_char(lo.expires_on, 'YYYY-MM-DD') as expires_on, h.quantity as quantity, u.code as base_unit_code`,
  defaultOrder: (tx) => tx`it.code asc, w.code asc, lo.code asc`,
});

// ── cost_layer — read as stored. LEGACY-055: stock ageing reads layers, it never recomputes a cost ──────
const COST_LAYER_COLUMNS: readonly DatasetColumn[] = [
  { field: "layer_id", kind: "uuid", ref: (tx) => tx`cl.id` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`cl.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`cl.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`cl.lot_id` },
  { field: "lot_code", kind: "text", ref: (tx) => tx`lo.code` },
  { field: "movement_id", kind: "uuid", ref: (tx) => tx`cl.movement_id` },
  { field: "qty_in", kind: "numeric", ref: (tx) => tx`cl.qty_in` },
  { field: "qty_remaining", kind: "numeric", ref: (tx) => tx`cl.qty_remaining` },
  { field: "unit_cost", kind: "numeric", ref: (tx) => tx`cl.unit_cost` },
  { field: "effective_at", kind: "date", ref: (tx) => tx`cl.effective_at` },
  { field: "sequence", kind: "integer", ref: (tx) => tx`cl.sequence` },
  { field: "invalidated_at", kind: "timestamp", ref: (tx) => tx`cl.invalidated_at` },
  // The age bucket a stock-ageing report groups on. It is a DATE difference, never a cost calculation.
  { field: "age_days", kind: "integer", ref: (tx) => tx`(current_date - cl.effective_at)` },
];

export const costLayerDataset: Dataset = defineDataset({
  id: "cost_layer",
  columns: COST_LAYER_COLUMNS,
  company: (tx, companyId) => tx`cl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.cost_layer cl
        join app.item      it on it.id = cl.item_id
        join app.warehouse w  on w.id  = cl.warehouse_id
        join app.lot       lo on lo.id = cl.lot_id`,
  select: (tx) => tx`cl.id as layer_id, cl.item_id as item_id, it.code as item_code,
         cl.warehouse_id as warehouse_id, w.code as warehouse_code, cl.lot_id as lot_id, lo.code as lot_code,
         cl.movement_id as movement_id, cl.qty_in as qty_in, cl.qty_remaining as qty_remaining,
         cl.unit_cost as unit_cost, to_char(cl.effective_at, 'YYYY-MM-DD') as effective_at,
         cl.sequence::int as sequence,
         to_char(cl.invalidated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as invalidated_at,
         (current_date - cl.effective_at)::int as age_days`,
  defaultOrder: (tx) => tx`it.code asc, w.code asc, cl.effective_at asc, cl.sequence asc`,
});

// ── cost_consumption — which layer paid for which issue ─────────────────────────────────────────────
const COST_CONSUMPTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "consumption_id", kind: "uuid", ref: (tx) => tx`cc.id` },
  { field: "movement_id", kind: "uuid", ref: (tx) => tx`cc.movement_id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`m.document_id` },
  { field: "layer_id", kind: "uuid", ref: (tx) => tx`cc.layer_id` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`m.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`m.warehouse_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`m.lot_id` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`cc.quantity` },
  { field: "unit_cost", kind: "numeric", ref: (tx) => tx`cc.unit_cost` },
  { field: "value", kind: "numeric", ref: (tx) => tx`cc.value` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`m.effective_date` },
  { field: "invalidated_at", kind: "timestamp", ref: (tx) => tx`cc.invalidated_at` },
];

export const costConsumptionDataset: Dataset = defineDataset({
  id: "cost_consumption",
  columns: COST_CONSUMPTION_COLUMNS,
  company: (tx, companyId) => tx`cc.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.cost_consumption cc
        join app.inventory_movement m on m.id = cc.movement_id
        join app.item              it on it.id = m.item_id`,
  select: (tx) => tx`cc.id as consumption_id, cc.movement_id as movement_id, m.document_id as document_id,
         cc.layer_id as layer_id, m.item_id as item_id, it.code as item_code,
         m.warehouse_id as warehouse_id, m.lot_id as lot_id, cc.quantity as quantity,
         cc.unit_cost as unit_cost, cc.value as value,
         to_char(m.effective_date, 'YYYY-MM-DD') as effective_date,
         to_char(cc.invalidated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as invalidated_at`,
  defaultOrder: (tx) => tx`m.effective_date asc, m.posting_seq asc, cc.id asc`,
});

// ── stock_valuation — 3B's ASYNC projection; read, never re-derived (spec:1204) ──────────────────────
const STOCK_VALUATION_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`sv.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`sv.warehouse_id` },
  { field: "warehouse_code", kind: "text", ref: (tx) => tx`w.code` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`w.branch_id` },
  { field: "as_of", kind: "date", ref: (tx) => tx`sv.as_of` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`sv.quantity` },
  { field: "value", kind: "numeric", ref: (tx) => tx`sv.value` },
];

export const stockValuationDataset: Dataset = defineDataset({
  id: "stock_valuation",
  columns: STOCK_VALUATION_COLUMNS,
  company: (tx, companyId) => tx`sv.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.stock_valuation sv
        join app.item      it on it.id = sv.item_id
        join app.warehouse w  on w.id  = sv.warehouse_id`,
  select: (tx) => tx`sv.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         sv.warehouse_id as warehouse_id, w.code as warehouse_code, w.branch_id as branch_id,
         to_char(sv.as_of, 'YYYY-MM-DD') as as_of, sv.quantity as quantity, sv.value as value`,
  defaultOrder: (tx) => tx`sv.as_of desc, it.code asc, w.code asc`,
});

// ── item_profitability — 4B's ASYNC projection. 7B's profit-by-item report reads THIS, never a recompute ──
const ITEM_PROFITABILITY_COLUMNS: readonly DatasetColumn[] = [
  { field: "item_id", kind: "uuid", ref: (tx) => tx`ip.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "item_name_ar", kind: "text", ref: (tx) => tx`it.name_ar` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`ip.fiscal_period_id` },
  { field: "fiscal_period_code", kind: "text", ref: (tx) => tx`to_char(fp.starts_on, 'YYYY-MM')` },
  { field: "quantity_sold", kind: "numeric", ref: (tx) => tx`ip.quantity_sold` },
  { field: "revenue_base", kind: "numeric", ref: (tx) => tx`ip.revenue_base` },
  { field: "cogs_base", kind: "numeric", ref: (tx) => tx`ip.cogs_base` },
  { field: "margin_base", kind: "numeric", ref: (tx) => tx`ip.margin_base` },
];

export const itemProfitabilityDataset: Dataset = defineDataset({
  id: "item_profitability",
  columns: ITEM_PROFITABILITY_COLUMNS,
  company: (tx, companyId) => tx`ip.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.item_profitability ip
        join app.item          it on it.id = ip.item_id
        join app.fiscal_period fp on fp.id = ip.fiscal_period_id`,
  select: (tx) => tx`ip.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         it.name_ar as item_name_ar, ip.fiscal_period_id as fiscal_period_id,
         to_char(fp.starts_on, 'YYYY-MM') as fiscal_period_code,
         ip.quantity_sold as quantity_sold, ip.revenue_base as revenue_base, ip.cogs_base as cogs_base,
         ip.margin_base as margin_base`,
  defaultOrder: (tx) => tx`fp.starts_on desc, ip.margin_base desc`,
});
```

- [ ] **Step 4: Close the registry**

In `packages/db/src/reports/datasets.ts`, add the import and the eleven entries between `pdc` and `tax_transaction`:

```ts
import {
  costConsumptionDataset, costLayerDataset, inventoryMovementDataset, itemDataset, itemProfitabilityDataset,
  lotDataset, priceListLineDataset, promotionDataset, stockOnHandDataset, stockValuationDataset, warehouseDataset,
} from "./datasets/inventory";
// … inside DATASETS, after `pdc:` and before `tax_transaction:`:
  item: itemDataset,
  lot: lotDataset,
  warehouse: warehouseDataset,
  price_list_line: priceListLineDataset,
  promotion: promotionDataset,
  inventory_movement: inventoryMovementDataset,
  stock_on_hand: stockOnHandDataset,
  cost_layer: costLayerDataset,
  cost_consumption: costConsumptionDataset,
  stock_valuation: stockValuationDataset,
  item_profitability: itemProfitabilityDataset,
```

Then delete the Task 5 comment that explains the deliberate compile error — it is no longer true.

- [ ] **Step 5: Extend the source-scan assertion to all three dataset files**

In `datasets.test.ts`, change the loop of the "no template-literal or concatenated identifier" `it` to cover every file:

```ts
    for (const file of ["accounting.ts", "ar-ap.ts", "inventory.ts"]) {
```

- [ ] **Step 6: Run everything to see it pass**

Run: `bun run --cwd packages/db test -- reports/datasets && bun run typecheck && bun run lint:rules`
Expected: PASS throughout. The two registry-membership `it`s from Task 5 now see all twenty-six ids in order; `DATASETS` satisfies `Record<DatasetId, Dataset>`; `no-sql-concat`, `no-bare-db` and `posting-only-tables` report nothing (the datasets are reads, so `posting-only-tables` has nothing to say even about `ledger_entry`, `inventory_movement`, `cost_layer`, `cost_consumption`, `account_balance`, `stock_on_hand` and `tax_transaction` — the rule fires on `insert`, `update`, `delete` and `merge`, never on `select`).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/reports/datasets/inventory.ts packages/db/src/reports/datasets.ts \
        packages/db/test/reports/datasets.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add the eleven inventory datasets; the registry closes [7A T7]

All twenty-six 7A members of §4.16.2 are present, so DATASETS satisfies
Record<DatasetId, Dataset> and typecheck is green. cost_layer and
cost_consumption expose stored unit costs and a DATE age_days and compute no
cost of their own (LEGACY-055, spec:1228); stock_valuation and item_profitability
read 3B's and 4B's async projections and never re-derive them (spec:1204).

7B adds no dataset and never edits this file. 7C adds shift, till_event and
needs_attention; 8D the six HR members.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `renderReport` — the pure layout, the totals arithmetic, and `renderCsv`

§4.11.2 puts the layout in `packages/domain/src/reports/render.ts` and the engine adapters in `apps/worker`. This task is the pure half: dataset rows in, a `RenderedReport` value object out — grouped, subtotalled, totalled, sorted, formatted, and direction-aware. It has no I/O, no framework and no internal imports, so every layout question is answered by a unit test rather than by reading a PDF.

**Four decisions this task makes, each with its reason.**

1. **Totals aggregate in `Decimal` at the column's scale.** `sum` is exact; `count` is an integer; `avg` divides and rounds **`HALF_EVEN`** at the column's scale — a stated mode, because §4.2.1's rule is that rounding is never implicit. Money columns are scale 4, quantity 6, percent 6, integer 0. No JS `number` ever holds a monetary value (spec:2041; 0D's `no-number-money` lint covers `packages/domain`).
2. **Column order is logical and is never reversed for Arabic.** spec:2253 wants "column order" correct in both directions; the mechanism is `dir="rtl"` on the rendered container, which the PDF and XLSX renderers set. Reversing the array *and* setting `dir` double-flips and produces exactly the bug the requirement exists to prevent. `RenderedReport.dir` is the single carrier of direction.
3. **Formatting is injected.** `ReportFormatters` is a five-method interface; `intlFormatters(lang)` in domain implements it with `Intl` alone so the pure tests need no dependency, and `apps/worker` supplies an adapter over **`@dulja/i18n`**'s `formatDate` / `formatNumber` / `formatMoney` / `formatQuantity` (Task 10). The numeral system and the Hijri calendar are **0E's** policy (`FormatContext`), re-decided nowhere.
4. **`renderReport` never re-computes a stored amount.** It reads the string a dataset returned and formats it. spec:2041: "stored base amounts are never recomputed on read."

**Files:**
- Create: `packages/domain/src/reports/format.ts`, `packages/domain/src/reports/render.ts`, `packages/domain/test/reports/render.test.ts`, `packages/domain/test/reports/render.property.test.ts`
- Modify: `packages/domain/src/reports/index.ts`

**Interfaces:**
- Consumes: `Decimal` from `decimal.js` and `round`, `RoundingMode` from `packages/domain/src/money/rounding.ts` (§4.2.1, 0D); `ReportDefinition`, `Column`, `Group`, `Total`, `SortKey` from `./definition` (Task 4); `ReportColumnFormat`, `ReportFormat`, `ReportLang`, `ReportOrientation`, `ReportPaper` from `./codes` (Task 4).
- Produces:

```ts
// packages/domain/src/reports/format.ts
export interface ReportFormatters {
  date(isoDate: string): string;
  number(decimal: string, opts?: { minimumFractionDigits?: number; maximumFractionDigits?: number }): string;
  money(value: { amount: string; currency: string }): string;
  quantity(decimal: string): string;
  percent(decimal: string): string;
}
export interface IntlFormatterOptions {
  calendar?: "gregory" | "islamic-umalqura";     // default: gregory for en, islamic-umalqura for ar
  numberingSystem?: "latn" | "arab";             // default: latn for both — 0E's FormatContext default
  timeZone?: string;                              // default "Asia/Kuala_Lumpur" (spec:2039)
  currency?: string;                              // the company's base currency, for money without one
}
/** `Intl` only, no internal imports — the pure-test implementation. The worker replaces it with an
 *  adapter over `@dulja/i18n` so the numeral and calendar policy stays 0E's (Task 10). */
export function intlFormatters(lang: ReportLang, opts?: IntlFormatterOptions): ReportFormatters;

// packages/domain/src/reports/render.ts
export type ReportSourceRow = Readonly<Record<string, string | number | boolean | null>>;
export interface RenderedColumn {
  field: string; label: string; format: ReportColumnFormat; align: "start" | "end"; width: number | null;
}
export interface RenderedCell { field: string; text: string; raw: string | number | boolean | null }
export interface RenderedRow {
  kind: "data" | "subtotal" | "total";
  /** 0 for a data row and for the grand total; 1-based group depth for a subtotal. */
  level: number;
  /** The group label a subtotal belongs to, e.g. "asset"; null on a data row and on the grand total. */
  label: string | null;
  cells: readonly RenderedCell[];
}
export interface RenderedReport {
  code: string;
  title: string;
  dir: "ltr" | "rtl";
  lang: ReportLang;
  format: ReportFormat;
  header: string;
  footer: string;
  paper: ReportPaper;
  orientation: ReportOrientation;
  columns: readonly RenderedColumn[];        // LOGICAL order — never reversed for rtl
  rows: readonly RenderedRow[];
  rowCount: number;                           // data rows only
  generatedAt: string;                        // the caller's clock, so a test can pin it
}
export interface RenderOptions {
  format: ReportFormat;
  lang: ReportLang;
  formatters: ReportFormatters;
  /** The run's parameter values, for `{name}` substitution in the header and footer. */
  parameters?: Readonly<Record<string, string>>;
  /** RFC 3339 UTC. Defaults to `new Date().toISOString()`; a test passes a fixed value. */
  generatedAt?: string;
}
export function renderReport(
  definition: ReportDefinition, rows: readonly ReportSourceRow[], opts: RenderOptions,
): RenderedReport;
/** Pure text, so it lives in domain. RFC 4180 quoting; CRLF line endings; `bom` for Excel's UTF-8 sniffing. */
export function renderCsv(report: RenderedReport, opts?: { bom?: boolean }): string;
/** Substitutes `{name}` from the parameter map plus the four built-ins `code`, `title`, `generatedAt`, `rowCount`.
 *  An unknown name renders as the empty string — a header is decoration and must never fail a render. */
export function interpolate(template: string, values: Readonly<Record<string, string>>): string;
```

- [ ] **Step 1: Write the failing test**

`packages/domain/test/reports/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  interpolate, intlFormatters, renderCsv, renderReport,
  type ReportDefinition, type ReportSourceRow,
} from "../../src/reports";

const AT = "2026-03-31T08:00:00Z";

function trialBalance(): ReportDefinition {
  return {
    version: 1,
    code: "accounting.trial_balance",
    nameEn: "Trial balance",
    nameAr: "ميزان المراجعة",
    module: "accounting",
    permission: "accounting.report.read",
    parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
    dataset: { source: "account_balance", filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }] },
    columns: [
      { field: "account_type", labelEn: "Type", labelAr: "النوع", format: "text", align: "start" },
      { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start", width: 80 },
      { field: "account_name_en", labelEn: "Name", labelAr: "الاسم", format: "text", align: "start" },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
      { field: "base_credit", labelEn: "Credit", labelAr: "دائن", format: "money", align: "end" },
    ],
    groups: [{ field: "account_type", subtotal: true }],
    totals: [{ field: "base_debit", fn: "sum" }, { field: "base_credit", fn: "sum" }],
    sort: [{ field: "account_code", dir: "asc" }],
    layout: { orientation: "portrait", paper: "A4", header: "{title} — {generatedAt}", footer: "{rowCount} rows" },
    tieOut: { kind: "ledger_sum" },
  };
}

const ROWS: readonly ReportSourceRow[] = [
  { account_type: "asset", account_code: "1200", account_name_en: "Trade receivables", base_debit: "400.0000", base_credit: "0.0000" },
  { account_type: "asset", account_code: "1000", account_name_en: "Cash", base_debit: "120.5000", base_credit: "0.0000" },
  { account_type: "income", account_code: "4000", account_name_en: "Sales", base_debit: "0.0000", base_credit: "520.5000" },
];

const EN = { format: "csv" as const, lang: "en" as const, formatters: intlFormatters("en", { currency: "MYR" }), generatedAt: AT };

describe("renderReport — grouping, subtotals, totals, sort", () => {
  it("emits data rows in sort order inside each group, a subtotal per group and one grand total", () => {
    const r = renderReport(trialBalance(), ROWS, EN);
    expect(r.rows.map((row) => [row.kind, row.level, row.label, row.cells[1]?.raw])).toEqual([
      ["data", 0, null, "1000"],
      ["data", 0, null, "1200"],
      ["subtotal", 1, "asset", null],
      ["data", 0, null, "4000"],
      ["subtotal", 1, "income", null],
      ["total", 0, null, null],
    ]);
    expect(r.rowCount).toBe(3);
  });

  it("subtotals and the grand total are exact decimal sums, never floats", () => {
    const r = renderReport(trialBalance(), ROWS, EN);
    const cellOf = (row: (typeof r.rows)[number], field: string) => row.cells.find((c) => c.field === field)!;
    const assetSubtotal = r.rows.find((row) => row.kind === "subtotal" && row.label === "asset")!;
    expect(cellOf(assetSubtotal, "base_debit").raw).toBe("520.5000");
    const total = r.rows.find((row) => row.kind === "total")!;
    expect(cellOf(total, "base_debit").raw).toBe("520.5000");
    expect(cellOf(total, "base_credit").raw).toBe("520.5000");
    // A text column carries no aggregate on a subtotal or total row.
    expect(cellOf(total, "account_name_en").raw).toBeNull();
  });

  it("count and avg do what their names say, avg rounding HALF_EVEN at the column's scale", () => {
    const def = trialBalance();
    def.totals = [{ field: "base_debit", fn: "avg" }, { field: "account_code", fn: "count" }];
    const r = renderReport(def, ROWS, EN);
    const total = r.rows.find((row) => row.kind === "total")!;
    // 520.5000 / 3 = 173.50000 → HALF_EVEN at scale 4 → 173.5000
    expect(total.cells.find((c) => c.field === "base_debit")!.raw).toBe("173.5000");
    expect(total.cells.find((c) => c.field === "account_code")!.raw).toBe(3);
  });

  it("groups nest, and only a group marked subtotal emits a row", () => {
    const def = trialBalance();
    def.columns = [...def.columns, { field: "currency", labelEn: "Ccy", labelAr: "العملة", format: "text", align: "start" }];
    def.groups = [{ field: "account_type", subtotal: true }, { field: "currency", subtotal: false }];
    const rows = ROWS.map((r) => ({ ...r, currency: "MYR" }));
    const r = renderReport(def, rows, EN);
    expect(r.rows.filter((row) => row.kind === "subtotal").map((row) => [row.level, row.label]))
      .toEqual([[1, "asset"], [1, "income"]]);
  });
});

describe("renderReport — direction, labels and the header", () => {
  it("uses the Arabic labels and dir=rtl for lang ar, and keeps the column order logical", () => {
    const r = renderReport(trialBalance(), ROWS, {
      ...EN, lang: "ar", formatters: intlFormatters("ar", { currency: "MYR" }),
    });
    expect(r.dir).toBe("rtl");
    expect(r.title).toBe("ميزان المراجعة");
    expect(r.columns.map((c) => c.label)).toEqual(["النوع", "الرمز", "الاسم", "مدين", "دائن"]);
    // spec:2253's "column order" is carried by `dir`, not by reversing the array — reversing AND setting dir
    // double-flips, which is the bug the requirement exists to prevent.
    expect(r.columns.map((c) => c.field)).toEqual(
      renderReport(trialBalance(), ROWS, EN).columns.map((c) => c.field));
  });

  it("interpolates the header and footer from the parameters and the four built-ins", () => {
    const def = trialBalance();
    def.layout.header = "{title} / {code} / {fiscalPeriodId} / {missing}";
    const r = renderReport(def, ROWS, { ...EN, parameters: { fiscalPeriodId: "2026-03" } });
    expect(r.header).toBe("Trial balance / accounting.trial_balance / 2026-03 / ");
    expect(r.footer).toBe("3 rows");
    expect(r.generatedAt).toBe(AT);
  });

  it("interpolate leaves a doubled brace alone and never throws on an unknown name", () => {
    expect(interpolate("{{literal}} {a}", { a: "x" })).toBe("{literal} x");
    expect(interpolate("{nope}", {})).toBe("");
  });

  it("formats money, quantity, percent, date and integer cells and keeps the raw string beside the text", () => {
    const def = trialBalance();
    def.columns = [
      { field: "d", labelEn: "D", labelAr: "د", format: "date", align: "start" },
      { field: "q", labelEn: "Q", labelAr: "ك", format: "quantity", align: "end" },
      { field: "p", labelEn: "P", labelAr: "ن", format: "percent", align: "end" },
      { field: "n", labelEn: "N", labelAr: "ع", format: "integer", align: "end" },
      { field: "m", labelEn: "M", labelAr: "م", format: "money", align: "end" },
    ];
    def.groups = []; def.totals = []; def.sort = [];
    const r = renderReport(def, [{ d: "2026-01-15", q: "3.000000", p: "0.060000", n: 7, m: "1234.5000" }], EN);
    const cells = r.rows[0]!.cells;
    // `intlFormatters("en")` builds the tag `en-u-ca-gregory-nu-latn`, and ICU resolves a bare `en` to en-US
    // ordering: month-first, `Jan 15, 2026`. That is deliberately the same string 0E's `formatDate(iso, ctx,
    // "medium")` produces for locale `en` (0e:786-795), because Task 10 swaps this implementation for an
    // adapter over that function and a report must not change shape when it moves from the pure test to the
    // worker. Do NOT "fix" this to a day-first form by hand — the day-first house format would be an `en-GB`
    // base tag in BOTH implementations, which is 0E's `FormatContext` policy to change, not this slice's.
    expect(cells[0]!.text).toBe("Jan 15, 2026");
    expect(cells[0]!.raw).toBe("2026-01-15");
    expect(cells[1]!.text).toBe("3.000000");
    expect(cells[2]!.text).toBe("6%");
    expect(cells[3]!.text).toBe("7");
    // `currencyDisplay: "code"` separates the code from the number with U+00A0 NO-BREAK SPACE, not an ASCII
    // space — verified against the toolchain's ICU (Node 24 / ICU 77), not assumed. Neither line below
    // contains a literal NBSP: an invisible character in a source file is one an editor silently
    // "tidies" to a plain space, and the `it` would then fail for a reason nobody could see. So the
    // separator is normalised by code point for the text comparison and pinned by code point after it.
    expect(cells[4]!.text.split(String.fromCharCode(160)).join(" ")).toBe("MYR 1,234.50");
    expect(cells[4]!.text.charCodeAt(3)).toBe(160);                // the separator, pinned
    expect(cells[4]!.raw).toBe("1234.5000");        // the stored string, never re-computed (spec:2041)
  });

  it("renders a null as the empty string in every format", () => {
    const def = trialBalance();
    def.columns = [{ field: "m", labelEn: "M", labelAr: "م", format: "money", align: "end" }];
    def.groups = []; def.totals = []; def.sort = [];
    const r = renderReport(def, [{ m: null }], EN);
    expect(r.rows[0]!.cells[0]!.text).toBe("");
    expect(r.rows[0]!.cells[0]!.raw).toBeNull();
  });
});

describe("renderCsv", () => {
  it("emits a header row, CRLF endings and RFC 4180 quoting, deterministically", () => {
    const def = trialBalance();
    def.groups = []; def.totals = []; def.sort = [];
    def.columns = [
      { field: "a", labelEn: 'Say "hi"', labelAr: "قل", format: "text", align: "start" },
      { field: "b", labelEn: "B,C", labelAr: "ب", format: "text", align: "start" },
    ];
    const r = renderReport(def, [{ a: 'he said "no"', b: "x\ny" }], EN);
    const csv = renderCsv(r);
    expect(csv).toBe('"Say ""hi""","B,C"\r\n"he said ""no""","x\ny"\r\n');
    expect(renderCsv(r)).toBe(csv);
  });

  it("labels a subtotal and a total row in the first column and writes RAW values, not formatted ones", () => {
    const r = renderReport(trialBalance(), ROWS, EN);
    const lines = renderCsv(r).split("\r\n");
    // The row inventory is asserted in FULL rather than sampled, because the indices are the whole subtlety
    // here: `renderCsv` prepends ONE header line to the six rows the first `it` in this file pins — data
    // 1000, data 1200, subtotal asset, data 4000, subtotal income, total — and joins with CRLF, so the grand
    // total is index 6 and the trailing CRLF leaves an empty index 7. An off-by-one here reads the income
    // subtotal as the total and still looks plausible, which is exactly why every line is named.
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("Type,Code,Name,Debit,Credit");
    expect(lines[1]).toBe("asset,1000,Cash,120.5000,0.0000");
    expect(lines[2]).toBe("asset,1200,Trade receivables,400.0000,0.0000");
    expect(lines[3]).toBe("Subtotal asset,,,520.5000,0.0000");
    expect(lines[4]).toBe("income,4000,Sales,0.0000,520.5000");
    expect(lines[5]).toBe("Subtotal income,,,0.0000,520.5000");
    expect(lines[6]).toBe("Total,,,520.5000,520.5000");
    expect(lines[7]).toBe("");
    // A CSV is machine-read: the RAW decimal string travels, never a locale-formatted one. spec:1246's
    // "diffable" applies to output as much as to definitions.
  });

  it("prepends a UTF-8 BOM only when asked, so Excel reads Arabic and a parser is unaffected", () => {
    const r = renderReport(trialBalance(), ROWS, { ...EN, lang: "ar", formatters: intlFormatters("ar") });
    expect(renderCsv(r).startsWith("﻿")).toBe(false);
    expect(renderCsv(r, { bom: true }).startsWith("﻿")).toBe(true);
  });
});
```

`packages/domain/test/reports/render.property.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import fc from "fast-check";
import { intlFormatters, renderReport, type ReportDefinition } from "../../src/reports";

function grouped(): ReportDefinition {
  return {
    version: 1, code: "accounting.general_ledger", nameEn: "GL", nameAr: "دفتر",
    module: "accounting", permission: "accounting.report.read", parameters: [],
    dataset: { source: "ledger_entry", filters: [] },
    columns: [
      { field: "g", labelEn: "G", labelAr: "غ", format: "text", align: "start" },
      { field: "v", labelEn: "V", labelAr: "ق", format: "money", align: "end" },
    ],
    groups: [{ field: "g", subtotal: true }],
    totals: [{ field: "v", fn: "sum" }],
    sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
    tieOut: { kind: "none" },
  };
}

describe("renderReport totals arithmetic", () => {
  it("Σ subtotals = the grand total, exactly, over 2000 random row sets", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            g: fc.constantFrom("a", "b", "c"),
            v: fc.integer({ min: -9_999_999, max: 9_999_999 }).map((n) => new Decimal(n).div(10_000).toFixed(4)),
          }),
          { minLength: 1, maxLength: 40 },
        ),
        (rows) => {
          const r = renderReport(grouped(), rows, { format: "csv", lang: "en", formatters: intlFormatters("en") });
          const raw = (kind: "subtotal" | "total") =>
            r.rows.filter((row) => row.kind === kind)
              .map((row) => new Decimal(String(row.cells.find((c) => c.field === "v")!.raw)));
          const sumOfSubtotals = raw("subtotal").reduce((a, b) => a.plus(b), new Decimal(0));
          expect(sumOfSubtotals.toFixed(4)).toBe(raw("total")[0]!.toFixed(4));
        },
      ),
      { numRuns: 2000 },
    );
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/domain test -- reports/render`
Expected: FAIL — `intlFormatters is not exported by src/reports`.

- [ ] **Step 3: Write the formatters**

`packages/domain/src/reports/format.ts`:

```ts
import type { ReportLang } from "./codes";

export interface ReportFormatters {
  date(isoDate: string): string;
  number(decimal: string, opts?: { minimumFractionDigits?: number; maximumFractionDigits?: number }): string;
  money(value: { amount: string; currency: string }): string;
  quantity(decimal: string): string;
  percent(decimal: string): string;
}

export interface IntlFormatterOptions {
  calendar?: "gregory" | "islamic-umalqura";
  numberingSystem?: "latn" | "arab";
  timeZone?: string;
  currency?: string;
}

/**
 * `Intl` only. `packages/domain` imports nothing internal (§3.1), so it cannot reach `@dulja/i18n`; this
 * implementation exists so the layout tests need no dependency, and the worker replaces it with an adapter
 * over 0E's `formatDate` / `formatNumber` / `formatMoney` / `formatQuantity` (Task 10). The numeral system and
 * the Hijri calendar are 0E's `FormatContext` policy and are not re-decided here.
 *
 * Every amount stays a STRING through the whole function: `Intl.NumberFormat.prototype.format` accepts a
 * decimal string and formats it exactly, so no `Number()` conversion happens and spec:2041 holds.
 */
export function intlFormatters(lang: ReportLang, opts: IntlFormatterOptions = {}): ReportFormatters {
  const calendar = opts.calendar ?? (lang === "ar" ? "islamic-umalqura" : "gregory");
  const numberingSystem = opts.numberingSystem ?? "latn";
  const timeZone = opts.timeZone ?? "Asia/Kuala_Lumpur";
  const tag = `${lang}-u-ca-${calendar}-nu-${numberingSystem}`;

  const dateFormat = new Intl.DateTimeFormat(tag, { day: "2-digit", month: "short", year: "numeric", timeZone });

  return {
    date(isoDate) {
      // A date column is a `date`, not an instant: parse it at UTC noon so the display timeZone cannot shift
      // the calendar day (the classic off-by-one in a report rendered from a +08:00 machine).
      return dateFormat.format(new Date(`${isoDate}T12:00:00Z`));
    },
    number(decimal, o) {
      return new Intl.NumberFormat(tag, {
        minimumFractionDigits: o?.minimumFractionDigits ?? 0,
        maximumFractionDigits: o?.maximumFractionDigits ?? 6,
      }).format(decimal as unknown as number);
    },
    money(value) {
      const currency = value.currency || opts.currency || "XXX";
      return new Intl.NumberFormat(tag, { style: "currency", currency, currencyDisplay: "code" })
        .format(value.amount as unknown as number);
    },
    quantity(decimal) {
      return new Intl.NumberFormat(tag, { minimumFractionDigits: 6, maximumFractionDigits: 6, useGrouping: false })
        .format(decimal as unknown as number);
    },
    percent(decimal) {
      return new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 4 })
        .format(decimal as unknown as number);
    },
  };
}
```

- [ ] **Step 4: Write the renderer**

`packages/domain/src/reports/render.ts`:

```ts
import Decimal from "decimal.js";
import { round } from "../money/rounding";
import type { Column, ReportDefinition } from "./definition";
import type { ReportColumnFormat, ReportFormat, ReportLang, ReportOrientation, ReportPaper } from "./codes";
import type { ReportFormatters } from "./format";

export type ReportSourceRow = Readonly<Record<string, string | number | boolean | null>>;

export interface RenderedColumn {
  field: string; label: string; format: ReportColumnFormat; align: "start" | "end"; width: number | null;
}
export interface RenderedCell { field: string; text: string; raw: string | number | boolean | null }
export interface RenderedRow {
  kind: "data" | "subtotal" | "total";
  level: number;
  label: string | null;
  cells: readonly RenderedCell[];
}
export interface RenderedReport {
  code: string; title: string; dir: "ltr" | "rtl"; lang: ReportLang; format: ReportFormat;
  header: string; footer: string; paper: ReportPaper; orientation: ReportOrientation;
  columns: readonly RenderedColumn[]; rows: readonly RenderedRow[]; rowCount: number; generatedAt: string;
}
export interface RenderOptions {
  format: ReportFormat;
  lang: ReportLang;
  formatters: ReportFormatters;
  parameters?: Readonly<Record<string, string>>;
  generatedAt?: string;
}

/** The scale each column format aggregates and renders at. Money is `numeric(19,4)`, quantity `numeric(19,6)`. */
const SCALE: Readonly<Record<ReportColumnFormat, number>> = {
  money: 4, quantity: 6, percent: 6, integer: 0, text: 0, date: 0,
};

export function interpolate(template: string, values: Readonly<Record<string, string>>): string {
  // ONE pass over the template. `{{` and `}}` are literal braces; an unknown name renders empty, because a
  // decorative header must never fail a render whose numbers are fine. A multi-pass implementation using
  // sentinel characters would corrupt a template that legitimately contained the sentinel.
  return template.replace(/\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    return values[name as string] ?? "";
  });
}

function labelOf(column: Column, lang: ReportLang): string {
  return lang === "ar" ? column.labelAr : column.labelEn;
}

function cellText(
  value: string | number | boolean | null,
  format: ReportColumnFormat,
  currency: string,
  f: ReportFormatters,
): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  const raw = String(value);
  switch (format) {
    case "money": return f.money({ amount: raw, currency });
    case "quantity": return f.quantity(raw);
    case "percent": return f.percent(raw);
    case "integer": return f.number(raw, { maximumFractionDigits: 0 });
    case "date": return f.date(raw);
    case "text": return raw;
  }
}

/** Group-key comparison is on the RAW value, so grouping never depends on a locale. The separator and the
 *  null marker are spelled as escapes rather than literal control characters, so this file stays plain text. */
export const GROUP_KEY_SEPARATOR = "\u001f";
export const GROUP_KEY_NULL = "\u0000";
function groupKey(row: ReportSourceRow, fields: readonly string[]): string {
  return fields
    .map((field) => (row[field] === null || row[field] === undefined ? GROUP_KEY_NULL : String(row[field])))
    .join(GROUP_KEY_SEPARATOR);
}

function compareRaw(a: string | number | boolean | null, b: string | number | boolean | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
  const [x, y] = [String(a), String(b)];
  // A numeric string sorts numerically; anything else code-unit-wise, which is stable and locale-free.
  if (/^-?\d+(?:\.\d+)?$/.test(x) && /^-?\d+(?:\.\d+)?$/.test(y)) {
    const d = new Decimal(x).comparedTo(new Decimal(y));
    return d as -1 | 0 | 1;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

interface Aggregate { sum: Decimal; count: number }

function aggregateOf(rows: readonly ReportSourceRow[], field: string): Aggregate {
  let sum = new Decimal(0);
  let count = 0;
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined) continue;
    count += 1;
    if (typeof value === "boolean") continue;
    sum = sum.plus(new Decimal(String(value)));
  }
  return { sum, count };
}

/** `sum` is exact; `count` is an integer; `avg` divides and rounds HALF_EVEN at the column's scale — a stated
 *  mode, because §4.2.1 forbids implicit rounding anywhere money is involved. */
function totalValue(
  fn: "sum" | "count" | "avg", agg: Aggregate, format: ReportColumnFormat,
): string | number {
  if (fn === "count") return agg.count;
  const scale = SCALE[format];
  if (fn === "sum") return agg.sum.toFixed(scale);
  if (agg.count === 0) return new Decimal(0).toFixed(scale);
  return round(agg.sum.div(agg.count), scale, "HALF_EVEN").toFixed(scale);
}

function aggregateRow(
  kind: "subtotal" | "total",
  level: number,
  label: string | null,
  rows: readonly ReportSourceRow[],
  definition: ReportDefinition,
  currency: string,
  f: ReportFormatters,
  lang: ReportLang,
): RenderedRow {
  const byField = new Map(definition.totals.map((t) => [t.field, t.fn]));
  const cells = definition.columns.map((column): RenderedCell => {
    const fn = byField.get(column.field);
    if (fn === undefined) return { field: column.field, text: "", raw: null };
    const raw = totalValue(fn, aggregateOf(rows, column.field), column.format);
    const format = fn === "count" ? "integer" : column.format;
    return { field: column.field, text: cellText(raw, format, currency, f), raw };
  });
  // The label rides in the first column, which is where a reader looks for it in both directions.
  const first = cells[0];
  if (first !== undefined && byField.get(first.field) === undefined) {
    const text = kind === "total"
      ? (lang === "ar" ? "الإجمالي" : "Total")
      : (lang === "ar" ? `مجموع ${label ?? ""}` : `Subtotal ${label ?? ""}`);
    cells[0] = { field: first.field, text, raw: text };
  }
  return { kind, level, label, cells };
}

export function renderReport(
  definition: ReportDefinition,
  rows: readonly ReportSourceRow[],
  opts: RenderOptions,
): RenderedReport {
  const { lang, formatters: f } = opts;
  const currency = definition.columns.some((c) => c.format === "money")
    ? String(rows.find((r) => typeof r["currency"] === "string")?.["currency"] ?? "")
    : "";
  const generatedAt = opts.generatedAt ?? new Date().toISOString();

  // 1. sort — every key is a declared column (validateReportDefinition proved it), compared on the raw value
  const ordered = [...rows].sort((a, b) => {
    for (const key of definition.sort) {
      const c = compareRaw(a[key.field] ?? null, b[key.field] ?? null);
      if (c !== 0) return key.dir === "desc" ? -c : c;
    }
    return 0;
  });

  // 2. group — a stable partition on the raw group values, in first-appearance order after the sort
  const groupFields = definition.groups.map((g) => g.field);
  const partitions = new Map<string, ReportSourceRow[]>();
  for (const row of ordered) {
    const key = groupFields.length === 0 ? "" : groupKey(row, groupFields);
    const bucket = partitions.get(key);
    if (bucket === undefined) partitions.set(key, [row]);
    else bucket.push(row);
  }

  // 3. emit
  const out: RenderedRow[] = [];
  for (const [, bucket] of partitions) {
    for (const row of bucket) {
      out.push({
        kind: "data",
        level: 0,
        label: null,
        cells: definition.columns.map((column) => ({
          field: column.field,
          text: cellText(row[column.field] ?? null, column.format, currency, f),
          raw: row[column.field] ?? null,
        })),
      });
    }
    // One subtotal row per group marked `subtotal`, deepest first, labelled by that group's own value.
    definition.groups.forEach((group, depth) => {
      if (!group.subtotal || definition.totals.length === 0) return;
      const label = bucket[0] === undefined ? null : String(bucket[0][group.field] ?? "");
      out.push(aggregateRow("subtotal", depth + 1, label, bucket, definition, currency, f, lang));
    });
  }
  if (definition.totals.length > 0 && ordered.length > 0) {
    out.push(aggregateRow("total", 0, null, ordered, definition, currency, f, lang));
  }

  const title = lang === "ar" ? definition.nameAr : definition.nameEn;
  const built: Record<string, string> = {
    ...(opts.parameters ?? {}),
    code: definition.code,
    title,
    generatedAt,
    rowCount: String(ordered.length),
  };

  return {
    code: definition.code,
    title,
    dir: lang === "ar" ? "rtl" : "ltr",
    lang,
    format: opts.format,
    header: interpolate(definition.layout.header, built),
    footer: interpolate(definition.layout.footer, built),
    paper: definition.layout.paper,
    orientation: definition.layout.orientation,
    columns: definition.columns.map((column) => ({
      field: column.field,
      label: labelOf(column, lang),
      format: column.format,
      align: column.align,
      width: column.width ?? null,
    })),
    rows: out,
    rowCount: ordered.length,
    generatedAt,
  };
}

const CSV_NEEDS_QUOTE = /[",\r\n]/;

function csvField(value: string): string {
  return CSV_NEEDS_QUOTE.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * RFC 4180: CRLF endings, `"` doubled inside a quoted field. A CSV carries the RAW decimal string, never a
 * locale-formatted one — it is machine-read, and spec:1246's "diffable" applies to output too. The BOM is
 * opt-in: Excel needs it to sniff UTF-8 Arabic, and a strict parser must not be handed one uninvited.
 */
export function renderCsv(report: RenderedReport, opts: { bom?: boolean } = {}): string {
  const lines: string[] = [report.columns.map((c) => csvField(c.label)).join(",")];
  for (const row of report.rows) {
    lines.push(row.cells.map((cell) => {
      if (row.kind !== "data" && cell.raw !== null && typeof cell.raw === "string"
          && cell.text === cell.raw) return csvField(cell.raw);        // the label cell
      return csvField(cell.raw === null ? "" : String(cell.raw));
    }).join(","));
  }
  return `${opts.bom === true ? "﻿" : ""}${lines.join("\r\n")}\r\n`;
}
```

Add to `packages/domain/src/reports/index.ts`:

```ts
export * from "./format";
export * from "./render";
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `bun run --cwd packages/domain test -- reports/render`
Expected: PASS — every `it` in both files, including the 2000-case property test.

**If `Intl.NumberFormat.prototype.format` in the installed Node 24 refuses a string argument**, the cast `value as unknown as number` is a compile-time convenience over an ES2023 runtime feature and the call is correct; a `TypeError` there means the runtime is older than the toolchain declares. Do **not** "fix" it with `Number(value)` — that is exactly the float path spec:2041 forbids. Fix the runtime, or format the integer and fraction parts separately.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/reports/format.ts packages/domain/src/reports/render.ts \
        packages/domain/src/reports/index.ts packages/domain/test/reports/render.test.ts \
        packages/domain/test/reports/render.property.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): add renderReport, the totals arithmetic and renderCsv [7A T8]

Pure layout: sort, group, subtotal, grand total, formatting and direction, with
no I/O and no internal imports. Totals aggregate in Decimal at the column's
scale and avg names HALF_EVEN; a stored amount is formatted, never recomputed
(spec:2041). Column order stays logical and `dir` alone carries direction, so
rtl cannot double-flip (spec:2253). Formatting is injected, so 0E's numeral and
Hijri policy is not re-decided here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The financial-statement layouts — profit and loss, balance sheet, per BRANCH

The card's fifth deliverable: "Financial-statement layouts: balance sheet and P&L, per BRANCH from the mandatory dimension (spec:1066), as definitions." §4.16.1 splits the ownership precisely — **the layout is 7A's, the definition is 7B's** for both `accounting.profit_and_loss` and `accounting.balance_sheet`, and **7A seeds no report**. So this task ships the reusable layout fragments plus the section classifier, and proves them by building a definition from them in a test and tying its totals to `account_balance`.

**Files:**
- Create: `packages/domain/src/reports/statement.ts`, `packages/domain/test/reports/statement.test.ts`, `packages/domain/test/reports/fixture/statement-rows.json`, `packages/db/src/reports/statement.ts`, `packages/db/test/reports/statement-tie-out.test.ts`
- Modify: `packages/domain/src/reports/index.ts`, `packages/db/src/reports/index.ts`

**Interfaces:**
- Consumes: `ReportDefinition`, `Column`, `Group`, `Total`, `SortKey` (Task 4); `renderReport`, `RenderedReport`, `ReportSourceRow`, `intlFormatters` (Task 8); `accountBalanceDataset`, `ledgerEntryDataset`, `datasetFor`, `Dataset`, `DatasetRow`, `ReportError` (Tasks 5–7); `trialBalance` from `packages/db/src/reports/trial-balance.ts` (1B, §4.16.3) — read for the tie-out only, never modified; `seedAccount`, `seedBranch`, `seedTenantV2`, `grantCodes` (§4.17); **`postJournal`, `JournalLine`** (§4.17.1, 1B) — the tie-out test posts through the shared helper, exactly as Task 5's `datasets.test.ts` does, and the same 3B amendment A21(c) makes the import legal from `packages/db/test/**` (3b:3333; Task 5's Consumes block carries the two confirming greps).
- Produces:

```ts
// packages/domain/src/reports/statement.ts
export type StatementKind = "profit_and_loss" | "balance_sheet";
export type StatementSection =
  | "revenue" | "expense" | "net_result"                       // profit_and_loss
  | "asset" | "liability" | "equity";                           // balance_sheet
/** `app.account_type` → the statement section it belongs to. The classifier is a total function over the
 *  five enum labels of migration 0001; there is no default arm, so a sixth label would be a compile error. */
export function statementSectionFor(kind: StatementKind, accountType: string): StatementSection | null;
export interface StatementLayoutOptions {
  /** true adds the BRANCH group above the section group (spec:1066 — BRANCH is the mandatory dimension). */
  perBranch?: boolean;
  paper?: ReportPaper;
  orientation?: ReportOrientation;
}
export interface StatementLayout {
  columns: ReportDefinition["columns"];
  groups: ReportDefinition["groups"];
  totals: ReportDefinition["totals"];
  sort: ReportDefinition["sort"];
  layout: ReportDefinition["layout"];
  parameters: ReportDefinition["parameters"];
  dataset: ReportDefinition["dataset"];
  tieOut: ReportDefinition["tieOut"];
}
/** The frozen fragment pair 7B's two definitions and 7C's `accounting.branch_profit_and_loss` are built from. */
export const STATEMENT_LAYOUTS: Readonly<Record<StatementKind, StatementLayout>>;
export function statementLayout(kind: StatementKind, opts?: StatementLayoutOptions): StatementLayout;
/**
 * The three §4.16.1 report codes that are statements, and which statement each one is. **This is the binding
 * that tells the run path, the definition store and the seed loader that a definition is a statement rather
 * than a plain dataset read** — nothing else distinguishes them. It is not a fourth register: every key is a
 * row §4.16.1 already carries, and a code that section does not carry cannot be added here.
 */
export const STATEMENT_CODES: Readonly<Record<string, StatementKind>>;   // exactly the three keys below
/** `null` for every code that is not a statement — the total-function form `statementSectionFor` uses, so a
 *  caller never indexes `STATEMENT_CODES` and gets `undefined` typed as `StatementKind`. */
export function statementKindFor(code: string): StatementKind | null;
/**
 * The three fields a statement's rows carry that its dataset's `DatasetColumn` list does not: `section` is
 * annotated by `statementRows` from `statementSectionFor`, and `branch_code` / `branch_id` come from the
 * `ledger_entry` read the per-BRANCH variant performs instead (see `statementRows`). `assertDefinitionFields`
 * unions these into the known set **only** for a statement code, so a typo in any other definition is still
 * refused.
 */
export const STATEMENT_EXTRA_FIELDS: readonly ["section", "branch_code", "branch_id"];
/** Composes a layout with the identity a code carries. 7B calls this in its seed-file generator. */
export function statementDefinition(
  kind: StatementKind,
  identity: { code: string; nameEn: string; nameAr: string; permission: string },
  opts?: StatementLayoutOptions,
): ReportDefinition;

// packages/db/src/reports/statement.ts
export interface StatementParams {
  companyId: string; fiscalPeriodId: string; branchId?: string | null; limit?: number;
}
/** Reads `account_balance` through the dataset registry and annotates each row with its statement section,
 *  so the pure layout groups on a column that exists rather than on a computed one. */
export async function statementRows(tx: Sql, kind: StatementKind, params: StatementParams): Promise<DatasetRow[]>;
/**
 * **The ONE row provider every run path goes through.** A statement code dispatches to `statementRows`; every
 * other code is the plain `datasetFor(source).run(...)` read. The render job (Task 11) calls this and never
 * `datasetFor` directly, which is what makes `statementRows` reachable outside its own test file.
 */
export async function rowsForDefinition(
  tx: Sql,
  definition: ReportDefinition,
  params: { companyId: string; parameters: Readonly<Record<string, string>>; limit?: number },
): Promise<DatasetRow[]>;
// NOTE for 7B/7C: on the statement branch the definition's `dataset.filters` are NOT consulted — the two
// queries `statementRows` owns take `fiscalPeriodId` and `branchId` and nothing else.
/**
 * **The ONE field check every store write and seed load goes through.** Every field a definition names in
 * `columns[]`, `groups[]`, `totals[]`, `sort[]` and `dataset.filters[]` must be a `DatasetColumn.field` of its
 * dataset — unioned with `STATEMENT_EXTRA_FIELDS` when `statementKindFor(definition.code) !== null`. Throws
 * `ReportError("ERR_VALIDATION_FAILED", …)` naming the dataset and every offending field.
 */
export function assertDefinitionFields(definition: ReportDefinition): void;
```

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/reports/fixture/statement-rows.json` — a golden chart-of-accounts position, balanced by construction:

```json
[
  { "section": "asset", "account_type": "asset", "account_code": "1000", "account_name_en": "Cash", "account_name_ar": "النقد", "base_debit": "5000.0000", "base_credit": "0.0000", "base_balance": "5000.0000", "branch_code": "HQ", "currency": "MYR" },
  { "section": "asset", "account_type": "asset", "account_code": "1200", "account_name_en": "Trade receivables", "account_name_ar": "الذمم المدينة", "base_debit": "3000.0000", "base_credit": "0.0000", "base_balance": "3000.0000", "branch_code": "HQ", "currency": "MYR" },
  { "section": "liability", "account_type": "liability", "account_code": "2100", "account_name_en": "Trade payables", "account_name_ar": "الذمم الدائنة", "base_debit": "0.0000", "base_credit": "2000.0000", "base_balance": "-2000.0000", "branch_code": "HQ", "currency": "MYR" },
  { "section": "equity", "account_type": "equity", "account_code": "3000", "account_name_en": "Share capital", "account_name_ar": "رأس المال", "base_debit": "0.0000", "base_credit": "4000.0000", "base_balance": "-4000.0000", "branch_code": "HQ", "currency": "MYR" },
  { "section": "revenue", "account_type": "income", "account_code": "4000", "account_name_en": "Sales", "account_name_ar": "المبيعات", "base_debit": "0.0000", "base_credit": "6000.0000", "base_balance": "-6000.0000", "branch_code": "HQ", "currency": "MYR" },
  { "section": "expense", "account_type": "expense", "account_code": "5000", "account_name_en": "Cost of goods sold", "account_name_ar": "تكلفة المبيعات", "base_debit": "4000.0000", "base_credit": "0.0000", "base_balance": "4000.0000", "branch_code": "HQ", "currency": "MYR" }
]
```

`packages/domain/test/reports/statement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import rows from "./fixture/statement-rows.json" with { type: "json" };
import {
  STATEMENT_CODES, STATEMENT_EXTRA_FIELDS, STATEMENT_LAYOUTS, intlFormatters, renderReport,
  statementDefinition, statementKindFor, statementLayout, statementSectionFor,
  validateReportDefinition, type ReportSourceRow,
} from "../../src/reports";

const SETS = {
  datasets: new Set(["account_balance", "ledger_entry"]),
  permissions: new Set(["accounting.report.read"]),
};
const PL = { code: "accounting.profit_and_loss", nameEn: "Profit and loss", nameAr: "الأرباح والخسائر", permission: "accounting.report.read" };
const BS = { code: "accounting.balance_sheet", nameEn: "Balance sheet", nameAr: "الميزانية العمومية", permission: "accounting.report.read" };

describe("statementSectionFor — a total function over the five account_type labels", () => {
  it("maps every label for both statements, and null where a label does not belong", () => {
    expect(statementSectionFor("profit_and_loss", "income")).toBe("revenue");
    expect(statementSectionFor("profit_and_loss", "expense")).toBe("expense");
    for (const t of ["asset", "liability", "equity"]) {
      expect(statementSectionFor("profit_and_loss", t), t).toBeNull();
    }
    expect(statementSectionFor("balance_sheet", "asset")).toBe("asset");
    expect(statementSectionFor("balance_sheet", "liability")).toBe("liability");
    expect(statementSectionFor("balance_sheet", "equity")).toBe("equity");
    for (const t of ["income", "expense"]) {
      expect(statementSectionFor("balance_sheet", t), t).toBeNull();
    }
  });
});

describe("STATEMENT_LAYOUTS", () => {
  it("both layouts produce a definition that validateReportDefinition accepts", () => {
    for (const [kind, identity] of [["profit_and_loss", PL], ["balance_sheet", BS]] as const) {
      const def = statementDefinition(kind, identity);
      expect(validateReportDefinition(def, SETS), kind).toEqual({ ok: true, errors: [] });
    }
  });

  it("reads account_balance — the synchronous projection — and declares its tie-out", () => {
    expect(STATEMENT_LAYOUTS.balance_sheet.dataset.source).toBe("account_balance");
    expect(STATEMENT_LAYOUTS.profit_and_loss.dataset.source).toBe("account_balance");
    expect(STATEMENT_LAYOUTS.balance_sheet.tieOut).toEqual({ kind: "ledger_sum" });
  });

  it("perBranch adds the BRANCH group ABOVE the section group and a branchId parameter (spec:1066)", () => {
    const plain = statementLayout("profit_and_loss");
    expect(plain.groups.map((g) => g.field)).toEqual(["section"]);
    expect(plain.parameters.map((p) => p.name)).toEqual(["fiscalPeriodId"]);

    const branched = statementLayout("profit_and_loss", { perBranch: true });
    expect(branched.groups.map((g) => g.field)).toEqual(["branch_code", "section"]);
    expect(branched.parameters.map((p) => p.name)).toEqual(["fiscalPeriodId", "branchId"]);
    expect(branched.dataset.filters.map((f) => f.param)).toEqual(["fiscalPeriodId", "branchId"]);
    expect(branched.layout.orientation).toBe("landscape");   // a branch column needs the width
  });

  it("the layout is a fragment pair, not a definition: it carries no code, name or module", () => {
    // §4.16.1 splits the ownership — the LAYOUT is 7A's, the DEFINITION is 7B's — and this assertion is what
    // stops 7A from seeding a report by accident.
    expect(Object.keys(STATEMENT_LAYOUTS.balance_sheet).sort())
      .toEqual(["columns", "dataset", "groups", "layout", "parameters", "sort", "tieOut", "totals"]);
  });
});

describe("STATEMENT_CODES — the run path's statement binding", () => {
  it("carries exactly §4.16.1's three statement codes and maps each to its kind", () => {
    expect(Object.keys(STATEMENT_CODES).sort()).toEqual([
      "accounting.balance_sheet", "accounting.branch_profit_and_loss", "accounting.profit_and_loss",
    ]);
    expect(statementKindFor("accounting.balance_sheet")).toBe("balance_sheet");
    expect(statementKindFor("accounting.profit_and_loss")).toBe("profit_and_loss");
    expect(statementKindFor("accounting.branch_profit_and_loss")).toBe("profit_and_loss");
  });

  it("returns null for every other code, so a plain report never takes the statement path", () => {
    for (const code of ["accounting.trial_balance", "accounting.ledger", "inventory.stock_on_hand", "pos.z_report"]) {
      expect(statementKindFor(code), code).toBeNull();
    }
  });

  it("every key is a §4.16.1 row this slice does NOT seed, and the extras are the three annotated fields", () => {
    // Naming three of §4.16.1's own rows is not seeding them: 7A ships the layouts and this binding, 7B ships
    // the two `accounting.*` definitions and 7C the branch one.
    expect([...STATEMENT_EXTRA_FIELDS]).toEqual(["section", "branch_code", "branch_id"]);
    for (const code of Object.keys(STATEMENT_CODES)) {
      expect(code.startsWith("accounting."), code).toBe(true);
    }
  });
});

describe("the rendered statements", () => {
  const f = intlFormatters("en", { currency: "MYR" });
  const render = (kind: "profit_and_loss" | "balance_sheet", identity: typeof PL) =>
    renderReport(
      statementDefinition(kind, identity),
      (rows as ReportSourceRow[]).filter((r) => statementSectionFor(kind, String(r["account_type"])) !== null),
      { format: "csv", lang: "en", formatters: f, generatedAt: "2026-03-31T08:00:00Z" },
    );

  it("the balance sheet balances once the period result is folded in: balance-sheet net + P&L net = 0", () => {
    const bs = render("balance_sheet", BS);
    const pl = render("profit_and_loss", PL);
    const net = (r: typeof bs) =>
      new Decimal(String(r.rows.find((row) => row.kind === "total")!
        .cells.find((c) => c.field === "base_balance")!.raw));
    const subtotal = (r: typeof bs, label: string) =>
      new Decimal(String(r.rows.find((row) => row.kind === "subtotal" && row.label === label)!
        .cells.find((c) => c.field === "base_balance")!.raw));

    // account_balance stores debit and credit; base_balance is debit − credit, so a liability, an equity and
    // a revenue line carries a NEGATIVE figure (spec:2041 — the sign is the ledger's, never flipped in a
    // report). The fixture is a PRE-CLOSING trial balance: Σ over ALL six rows is 0, and the three
    // balance-sheet sections alone therefore sum to +2000.0000 — exactly the negation of the P&L's
    // −2000.0000 — because the period result has not yet been closed into an equity account. Asserting
    // "asset + liability + equity = 0" on this fixture would be asserting a FALSE identity: with a non-zero
    // period result it cannot hold while the whole trial balance balances, which is why the assertion below
    // is the same one packages/db/test/reports/statement-tie-out.test.ts proves against the database.
    expect(net(bs).plus(net(pl)).toFixed(4)).toBe("0.0000");
    expect(net(bs).toFixed(4)).toBe("2000.0000");
    expect(subtotal(bs, "asset").toFixed(4)).toBe("8000.0000");
    expect(subtotal(bs, "liability").plus(subtotal(bs, "equity")).toFixed(4)).toBe("-6000.0000");
  });

  it("the P&L nets revenue against expense: income − expense = the grand total", () => {
    const r = render("profit_and_loss", PL);
    const total = new Decimal(String(
      r.rows.find((row) => row.kind === "total")!.cells.find((c) => c.field === "base_balance")!.raw));
    // revenue −6000 (credit) + expense +4000 (debit) = −2000, i.e. a 2000 profit under the ledger's sign.
    expect(total.toFixed(4)).toBe("-2000.0000");
  });

  it("renders in Arabic with the Arabic section labels and dir rtl", () => {
    const r = renderReport(
      statementDefinition("balance_sheet", BS),
      (rows as ReportSourceRow[]).filter((x) => statementSectionFor("balance_sheet", String(x["account_type"])) !== null),
      { format: "pdf", lang: "ar", formatters: intlFormatters("ar", { currency: "MYR" }), generatedAt: "2026-03-31T08:00:00Z" },
    );
    expect(r.dir).toBe("rtl");
    expect(r.title).toBe("الميزانية العمومية");
    expect(r.columns.map((c) => c.label)).toEqual(["القسم", "الرمز", "الاسم", "الرصيد"]);
  });
});
```

`packages/db/test/reports/statement-tie-out.test.ts` — the DoD's "every report's numbers tie to the ledger", proven for the layout 7A owns:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { intlFormatters, renderReport, statementDefinition, statementSectionFor } from "@dulja/domain";
import { assertDefinitionFields, rowsForDefinition, statementRows } from "../../src/reports/statement";
import { trialBalance } from "../../src/reports/trial-balance";
// §4.17.1's shared helper, reachable here through 3B's amendment A21(c) — see Task 5's Consumes block for
// the two greps that confirm the allowance and the tsconfig `include` are on the head (3b:3333).
import { postJournal, type JournalLine } from "../../../../tests/invariants/support/post-journal";
import { grantCodes, seedAccount, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("the statement layouts tie to account_balance to the cent", () => {
  let db: Db;
  let s: Seed;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "statement-tie");
    await grantCodes(db, s, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    const cash = await seedAccount(db, s, { code: "1000", nameEn: "Cash", type: "asset" });
    const capital = await seedAccount(db, s, { code: "3000", nameEn: "Share capital", type: "equity" });
    const sales = await seedAccount(db, s, { code: "4000", nameEn: "Sales", type: "income" });
    const cogs = await seedAccount(db, s, { code: "5000", nameEn: "Cost of goods sold", type: "expense" });
    // The same shared helper `datasets.test.ts` uses: it drafts a JOURNAL and posts it through the real
    // `postDocument` (§4.3.1), so the tie-out below reads projections the posting service wrote and nothing
    // in this file touches `ledger_entry` or `account_balance` itself. `postJournal`'s defaults are this
    // fixture's — 2026-01-15 in `s.period`, MYR at rate 1, actor `s.human` — so no options are passed.
    // Three documents: capital in, a sale, and cost of goods sold paid out of cash.
    const post = (lines: JournalLine[]) => postJournal(db, s, lines);
    await post([{ account: cash, debit: "4000.0000" }, { account: capital, credit: "4000.0000" }]);
    await post([{ account: cash, debit: "6000.0000" }, { account: sales, credit: "6000.0000" }]);
    await post([{ account: cogs, debit: "4000.0000" }, { account: cash, credit: "4000.0000" }]);
  });
  afterAll(async () => { await db.stop(); });

  it("Σ balance-sheet sections + Σ P&L net = 0, and both come from account_balance", async () => {
    const { bs, pl, tb } = await withTenant(db.rw, s.tenant, s.human, async (tx) => ({
      bs: await statementRows(tx, "balance_sheet", { companyId: s.company, fiscalPeriodId: s.period }),
      pl: await statementRows(tx, "profit_and_loss", { companyId: s.company, fiscalPeriodId: s.period }),
      tb: await trialBalance(tx, { companyId: s.company, fiscalPeriodId: s.period, limit: 1000 }),
    }));

    const f = intlFormatters("en", { currency: "MYR" });
    const identity = (code: string) => ({ code, nameEn: code, nameAr: code, permission: "accounting.report.read" });
    const totalOf = (kind: "balance_sheet" | "profit_and_loss", source: typeof bs) => {
      const r = renderReport(statementDefinition(kind, identity(`accounting.${kind}`)), source,
        { format: "csv", lang: "en", formatters: f });
      return new Decimal(String(
        r.rows.find((row) => row.kind === "total")!.cells.find((c) => c.field === "base_balance")!.raw));
    };

    // Σdebit = Σcredit over the whole ledger, so balance-sheet net + P&L net = 0 exactly (spec:2419 test 1).
    expect(totalOf("balance_sheet", bs).plus(totalOf("profit_and_loss", pl)).toFixed(4)).toBe("0.0000");

    // And the statements read the SAME projection 1B's trial balance reads — never a re-aggregation of
    // ledger_entry, because a report that quietly recomputed would hide the drift the integrity job finds.
    const tbNet = tb.reduce(
      (acc, row) => acc.plus(new Decimal(row.baseDebit)).minus(new Decimal(row.baseCredit)), new Decimal(0));
    expect(tbNet.toFixed(4)).toBe("0.0000");
    expect(bs.length + pl.length).toBe(tb.length);
  });

  it("statementRows annotates every row with its section and filters the other statement's types out", async () => {
    const bs = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      statementRows(tx, "balance_sheet", { companyId: s.company, fiscalPeriodId: s.period }));
    expect(new Set(bs.map((r) => r["section"]))).toEqual(new Set(["asset", "equity"]));
    for (const row of bs) {
      expect(statementSectionFor("balance_sheet", String(row["account_type"]))).toBe(row["section"]);
    }
  });

  it("a branch filter narrows the P&L without changing the arithmetic (spec:1066)", async () => {
    const all = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      statementRows(tx, "profit_and_loss", { companyId: s.company, fiscalPeriodId: s.period }));
    const hq = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      statementRows(tx, "profit_and_loss", { companyId: s.company, fiscalPeriodId: s.period, branchId: s.hq }));
    // Every document in this fixture is a head-office JOURNAL, so the two agree; the assertion is that the
    // branch path exists and returns the same figures rather than a different aggregation.
    expect(hq.map((r) => [r["account_code"], r["base_balance"]]))
      .toEqual(all.map((r) => [r["account_code"], r["base_balance"]]));
  });

  it("rowsForDefinition routes a STATEMENT code to statementRows and every other code to its dataset", async () => {
    const bsDefinition = statementDefinition("balance_sheet", {
      code: "accounting.balance_sheet", nameEn: "Balance sheet", nameAr: "الميزانية العمومية",
      permission: "accounting.report.read",
    });
    const plainDefinition = {
      ...bsDefinition,
      code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
      columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
      groups: [], totals: [], sort: [], tieOut: { kind: "none" },
    } as typeof bsDefinition;

    const { statement, plain } = await withTenant(db.rw, s.tenant, s.human, async (tx) => ({
      statement: await rowsForDefinition(tx, bsDefinition, {
        companyId: s.company, parameters: { fiscalPeriodId: s.period },
      }),
      plain: await rowsForDefinition(tx, plainDefinition, {
        companyId: s.company, parameters: { fiscalPeriodId: s.period },
      }),
    }));

    // The statement path annotates `section`; the plain dataset read cannot, because `account_balance`
    // declares no such column — which is precisely the difference the binding exists to make.
    expect(statement.every((r) => r["section"] !== undefined)).toBe(true);
    expect(plain.every((r) => r["section"] === undefined)).toBe(true);
    expect(new Set(statement.map((r) => r["section"]))).toEqual(new Set(["asset", "equity"]));
  });

  it("assertDefinitionFields accepts a statement's three extra fields and still refuses a typo", () => {
    const bs = statementDefinition("balance_sheet", {
      code: "accounting.balance_sheet", nameEn: "Balance sheet", nameAr: "الميزانية العمومية",
      permission: "accounting.report.read",
    });
    // `section` is annotated, not selected; the per-BRANCH variant's `branch_code`/`branch_id` come from the
    // `ledger_entry` read. Without the union, EVERY statement definition would be unstorable and unseedable.
    expect(() => assertDefinitionFields(bs)).not.toThrow();
    expect(() => assertDefinitionFields(
      statementDefinition("profit_and_loss", {
        code: "accounting.branch_profit_and_loss", nameEn: "Branch P&L", nameAr: "أرباح الفرع",
        permission: "accounting.report.read",
      }, { perBranch: true }),
    )).not.toThrow();

    // The same three fields on a NON-statement code are still a typo, and are still named in the message.
    const notAStatement = { ...bs, code: "accounting.trial_balance" };
    expect(() => assertDefinitionFields(notAStatement)).toThrowError(/has no such field: section/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/domain test -- reports/statement`
Expected: FAIL — `statementSectionFor is not exported by src/reports`.

- [ ] **Step 3: Write the layouts**

`packages/domain/src/reports/statement.ts`:

```ts
import type { ReportDefinition } from "./definition";
import type { ReportOrientation, ReportPaper } from "./codes";

export type StatementKind = "profit_and_loss" | "balance_sheet";
export type StatementSection =
  | "revenue" | "expense" | "net_result"
  | "asset" | "liability" | "equity";

/**
 * `app.account_type` → the statement section. Total over the five enum labels migration 0001 defines
 * (`asset`, `liability`, `equity`, `income`, `expense`); no default arm, so §3.4.4's "no slice adds an enum
 * label" is enforced here by the compiler rather than by a comment. `null` means "this label belongs to the
 * other statement", which is what lets one classifier drive both.
 */
export function statementSectionFor(kind: StatementKind, accountType: string): StatementSection | null {
  if (kind === "profit_and_loss") {
    return accountType === "income" ? "revenue" : accountType === "expense" ? "expense" : null;
  }
  return accountType === "asset" ? "asset"
    : accountType === "liability" ? "liability"
    : accountType === "equity" ? "equity"
    : null;
}

/** The bilingual section headings the `section` column renders. `net_result` is the P&L's grand-total label. */
export const STATEMENT_SECTION_LABELS: Readonly<Record<StatementSection, { en: string; ar: string }>> = {
  revenue: { en: "Revenue", ar: "الإيرادات" },
  expense: { en: "Expenses", ar: "المصروفات" },
  net_result: { en: "Net result", ar: "النتيجة الصافية" },
  asset: { en: "Assets", ar: "الأصول" },
  liability: { en: "Liabilities", ar: "الالتزامات" },
  equity: { en: "Equity", ar: "حقوق الملكية" },
};

export interface StatementLayoutOptions {
  perBranch?: boolean;
  paper?: ReportPaper;
  orientation?: ReportOrientation;
}

export interface StatementLayout {
  columns: ReportDefinition["columns"];
  groups: ReportDefinition["groups"];
  totals: ReportDefinition["totals"];
  sort: ReportDefinition["sort"];
  layout: ReportDefinition["layout"];
  parameters: ReportDefinition["parameters"];
  dataset: ReportDefinition["dataset"];
  tieOut: ReportDefinition["tieOut"];
}

/**
 * The four columns both statements share. `base_balance` is `base_debit − base_credit` as `account_balance`
 * stores it (§4.3.3), so a liability, equity and revenue line carries a NEGATIVE figure. The sign is the
 * ledger's; a statement never flips it, because a flipped sign in a report is how a reader loses the ability
 * to add two reports together (spec:2041).
 */
const BASE_COLUMNS: ReportDefinition["columns"] = [
  { field: "section", labelEn: "Section", labelAr: "القسم", format: "text", align: "start", width: 120 },
  { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start", width: 80 },
  { field: "account_name_en", labelEn: "Name", labelAr: "الاسم", format: "text", align: "start" },
  { field: "base_balance", labelEn: "Balance", labelAr: "الرصيد", format: "money", align: "end", width: 120 },
];

const BRANCH_COLUMN: ReportDefinition["columns"][number] =
  { field: "branch_code", labelEn: "Branch", labelAr: "الفرع", format: "text", align: "start", width: 100 };

function build(kind: StatementKind, opts: StatementLayoutOptions): StatementLayout {
  const perBranch = opts.perBranch === true;
  const columns = perBranch ? [BRANCH_COLUMN, ...BASE_COLUMNS] : [...BASE_COLUMNS];
  const groups: ReportDefinition["groups"] = perBranch
    ? [{ field: "branch_code", subtotal: true }, { field: "section", subtotal: true }]
    : [{ field: "section", subtotal: true }];
  const parameters: ReportDefinition["parameters"] = [
    { name: "fiscalPeriodId", kind: "period", required: true },
    ...(perBranch ? [{ name: "branchId", kind: "branch" as const, required: false }] : []),
  ];
  const filters: ReportDefinition["dataset"]["filters"] = [
    { field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" },
    ...(perBranch ? [{ field: "branch_id", op: "eq" as const, param: "branchId" }] : []),
  ];
  const heading = kind === "balance_sheet"
    ? "{title} — {fiscalPeriodId}"
    : "{title} — {fiscalPeriodId}";
  return {
    columns,
    groups,
    totals: [{ field: "base_balance", fn: "sum" }],
    sort: [{ field: "section", dir: "asc" }, { field: "account_code", dir: "asc" }],
    parameters,
    dataset: { source: "account_balance", filters },
    layout: {
      orientation: opts.orientation ?? (perBranch ? "landscape" : "portrait"),
      paper: opts.paper ?? "A4",
      header: heading,
      footer: "{rowCount} accounts · {generatedAt}",
    },
    // Both statements are read from `account_balance`, which the posting service MERGEs in the same
    // transaction as the ledger (§4.3.3, D14), so `ledger_sum` is the tie-out kind and 7B's tie-out test
    // compares the statement's grand totals to the same projection the trial balance reads.
    tieOut: { kind: "ledger_sum" },
  };
}

/** The frozen pair. 7B builds `accounting.profit_and_loss` and `accounting.balance_sheet` from these and
 *  7C builds `accounting.branch_profit_and_loss` from `statementLayout("profit_and_loss", { perBranch: true })`. */
export const STATEMENT_LAYOUTS: Readonly<Record<StatementKind, StatementLayout>> = {
  profit_and_loss: build("profit_and_loss", {}),
  balance_sheet: build("balance_sheet", {}),
};

export function statementLayout(kind: StatementKind, opts: StatementLayoutOptions = {}): StatementLayout {
  return build(kind, opts);
}

export function statementDefinition(
  kind: StatementKind,
  identity: { code: string; nameEn: string; nameAr: string; permission: string },
  opts: StatementLayoutOptions = {},
): ReportDefinition {
  const fragment = statementLayout(kind, opts);
  return {
    version: 1,
    code: identity.code,
    nameEn: identity.nameEn,
    nameAr: identity.nameAr,
    // The module is the code's own first segment (§4.16.1); both statement codes are `accounting.*`.
    module: "accounting",
    permission: identity.permission,
    ...fragment,
  };
}

/**
 * The three §4.16.1 codes whose definitions are STATEMENTS, and which statement each is. This map is the one
 * binding that tells the run path, the definition store and the seed loader that a definition's rows come
 * from `statementRows` rather than from a plain `datasetFor(source).run(...)`.
 *
 * It is not a fourth register (hazard 32): every key is a row §4.16.1 already carries — `accounting.profit_and_loss`
 * and `accounting.balance_sheet` (7B's definitions, 7A's layouts) and `accounting.branch_profit_and_loss`
 * (7C's) — and a code that section does not carry cannot be added, because there would be no layout to
 * build it from. 7A seeds none of the three; it ships the layouts and this binding.
 */
export const STATEMENT_CODES: Readonly<Record<string, StatementKind>> = {
  "accounting.profit_and_loss": "profit_and_loss",
  "accounting.balance_sheet": "balance_sheet",
  "accounting.branch_profit_and_loss": "profit_and_loss",
};

/** `null` for every code that is not one of the three, so a caller never indexes the map and gets an
 *  `undefined` typed as `StatementKind`. Same total-function shape as `statementSectionFor`. */
export function statementKindFor(code: string): StatementKind | null {
  return Object.prototype.hasOwnProperty.call(STATEMENT_CODES, code) ? STATEMENT_CODES[code]! : null;
}

/**
 * The three fields a statement's ROWS carry that its dataset's declared `DatasetColumn` list does not.
 *
 * - `section` is annotated in TypeScript by `statementRows` from `statementSectionFor`, deliberately rather
 *   than as a SQL `case` over `ac.type`, so the classification lives in one total function instead of a
 *   CASE expression a second slice would copy.
 * - `branch_code` / `branch_id` exist because `account_balance`'s key is
 *   `(company_id, account_id, fiscal_period_id, currency)` and carries **no branch** (§4.3.3): the per-BRANCH
 *   statement of spec:1066 is served by `statementRows` reading the `ledger_entry` dataset — which does carry
 *   both, from the document join — and collapsing it to the `account_balance` row shape. The definition's
 *   `dataset.source` therefore names the row SHAPE both paths produce, and `rowsForDefinition` is what picks
 *   the query.
 *
 * `assertDefinitionFields` unions these into the known set **only** for a `STATEMENT_CODES` key, so a typo in
 * any other definition is still refused with the field's name.
 */
export const STATEMENT_EXTRA_FIELDS = ["section", "branch_code", "branch_id"] as const;
```

Add `export * from "./statement";` to `packages/domain/src/reports/index.ts`.

- [ ] **Step 4: Write the db-side row reader**

`packages/db/src/reports/statement.ts`:

```ts
import type { Sql } from "postgres";
import {
  STATEMENT_EXTRA_FIELDS, statementKindFor, statementSectionFor,
  type ReportDefinition, type StatementKind,
} from "@dulja/domain";
import { datasetFor } from "./datasets";
import { ReportError } from "./errors";
import type { DatasetRow } from "./query";

export interface StatementParams {
  companyId: string;
  fiscalPeriodId: string;
  branchId?: string | null;
  limit?: number;
}

/**
 * Reads the `account_balance` dataset and annotates each row with its statement `section`, so the pure layout
 * groups on a column that EXISTS. Doing the classification here rather than in SQL keeps the mapping in one
 * total TypeScript function (`statementSectionFor`) instead of a CASE expression a second slice would copy.
 *
 * A branch filter goes through the `ledger_entry` dataset instead, because `account_balance` has no branch key
 * (§4.3.3's primary key is company/account/period/currency): the per-BRANCH statement of spec:1066 is a
 * ledger read grouped to the same shape, and the two agree because the projection is a pure sum of the ledger.
 */
export async function statementRows(
  tx: Sql,
  kind: StatementKind,
  params: StatementParams,
): Promise<DatasetRow[]> {
  const limit = params.limit ?? 10_000;
  if (params.branchId === undefined || params.branchId === null) {
    const rows = await datasetFor("account_balance").run(tx, {
      companyId: params.companyId,
      filters: [{ field: "fiscal_period_id", op: "eq", value: params.fiscalPeriodId }],
      sort: [{ field: "account_code", dir: "asc" }],
      limit,
      offset: 0,
    });
    return annotate(rows, kind, (row) => ({ ...row, branch_code: null }));
  }

  const entries = await datasetFor("ledger_entry").run(tx, {
    companyId: params.companyId,
    filters: [
      { field: "fiscal_period_id", op: "eq", value: params.fiscalPeriodId },
      { field: "branch_id", op: "eq", value: params.branchId },
    ],
    sort: [{ field: "account_code", dir: "asc" }],
    limit,
    offset: 0,
  });
  // `collapse` sums the branch's ledger rows to one row per account, giving exactly the shape
  // `account_balance` has. The arithmetic is exact integers of ten-thousandths, never a float (spec:2041).
  return annotate(collapse(entries), kind, (row) => row);
}

/** Sums a branch's ledger rows to one row per account, in SQL-produced decimal strings. */
function collapse(entries: readonly DatasetRow[]): DatasetRow[] {
  const out = new Map<string, { row: DatasetRow; debit: bigint; credit: bigint }>();
  for (const e of entries) {
    const key = String(e["account_id"]);
    const debit = scaled(String(e["base_debit"]));
    const credit = scaled(String(e["base_credit"]));
    const seen = out.get(key);
    if (seen === undefined) out.set(key, { row: e, debit, credit });
    else out.set(key, { row: seen.row, debit: seen.debit + debit, credit: seen.credit + credit });
  }
  return [...out.values()].map(({ row, debit, credit }) => ({
    ...row,
    base_debit: unscaled(debit),
    base_credit: unscaled(credit),
    base_balance: unscaled(debit - credit),
  }));
}

/** `numeric(19,4)` as an exact integer of ten-thousandths. No float, no `Decimal` import in `packages/db`. */
function scaled(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const sign = whole!.startsWith("-") ? -1n : 1n;
  const digits = `${whole!.replace("-", "")}${fraction.padEnd(4, "0").slice(0, 4)}`;
  return sign * BigInt(digits);
}

function unscaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

function annotate(
  rows: readonly DatasetRow[],
  kind: StatementKind,
  shape: (row: DatasetRow) => DatasetRow,
): DatasetRow[] {
  const out: DatasetRow[] = [];
  for (const row of rows) {
    const section = statementSectionFor(kind, String(row["account_type"]));
    if (section === null) continue;                   // the other statement's account types
    if (row["is_group"] === true) continue;           // a group account carries no balance of its own
    out.push({ ...shape(row), section });
  }
  return out;
}

/**
 * **The one row provider.** Every run of a report — the `reporting.render` handler (Task 11) and any later
 * caller — goes through this function and never calls `datasetFor(...).run` itself, which is what makes the
 * statement path reachable outside its own test file.
 *
 * On the **dataset** branch, a filter whose optional parameter was not supplied is DROPPED rather than bound
 * to `null`, so an absent `branchId` means "every branch" instead of "no rows". `validateReportDefinition`
 * already proved every filter names a declared parameter, so no unknown key can reach a query here.
 *
 * On the **statement** branch the definition's `dataset.filters` are NOT consulted at all: `statementRows`
 * owns its two queries and takes exactly `fiscalPeriodId` and `branchId`. A statement definition that
 * declares any other filter has it silently dropped — which is why `STATEMENT_LAYOUTS` declares only those
 * two, and why a catalogue slice writing a statement definition by hand rather than through
 * `statementDefinition` must keep to the same two parameters or its extra filter will do nothing.
 */
export async function rowsForDefinition(
  tx: Sql,
  definition: ReportDefinition,
  params: { companyId: string; parameters: Readonly<Record<string, string>>; limit?: number },
): Promise<DatasetRow[]> {
  const limit = params.limit ?? 100_000;
  const kind = statementKindFor(definition.code);
  if (kind !== null) {
    const branchId = params.parameters["branchId"];
    return statementRows(tx, kind, {
      companyId: params.companyId,
      fiscalPeriodId: params.parameters["fiscalPeriodId"]!,
      branchId: branchId === undefined || branchId === "" ? null : branchId,
      limit,
    });
  }
  const filters = definition.dataset.filters
    .filter((f) => params.parameters[f.param] !== undefined && params.parameters[f.param] !== "")
    .map((f) => ({ field: f.field, op: f.op, value: params.parameters[f.param]! }));
  return datasetFor(definition.dataset.source).run(tx, {
    companyId: params.companyId,
    filters,
    sort: definition.sort.map((s) => ({ field: s.field, dir: s.dir })),
    limit,
    offset: 0,
  });
}

/**
 * **The one field check.** Every field a definition names must exist on the rows its dataset produces.
 *
 * This cannot live in `packages/domain` beside the rest of the validation: `validateReportDefinition` takes
 * the dataset IDS and the permission codes as two `ReadonlySet<string>` (§4.11.1), and a dataset's column list
 * is a `DatasetColumn[]` whose `ref` is a `packages/db` closure — the very thing §3.1 keeps out of domain. So
 * it lives here, and the definition store (Task 13) and the seed loader (Task 14) both call it.
 *
 * It matters because the two places a bad field is *already* caught do not cover the display list: `columnOf`
 * (Task 5) raises for a filter or a sort key at RUN time, and nothing at all looks at `columns[]`, `groups[]`
 * or `totals[]`. A typo there renders as a silently empty column whose total still adds up — a report that is
 * wrong and looks right, which is the failure this whole slice exists to end.
 *
 * A **statement** code's rows carry three fields its dataset does not declare (`STATEMENT_EXTRA_FIELDS`), so
 * the known set is unioned for those three codes and for no others.
 */
export function assertDefinitionFields(definition: ReportDefinition): void {
  const dataset = datasetFor(definition.dataset.source);   // throws ERR_REPORT_DATASET_UNKNOWN
  const known = new Set<string>(dataset.columns.map((c) => c.field));
  if (statementKindFor(definition.code) !== null) {
    for (const extra of STATEMENT_EXTRA_FIELDS) known.add(extra);
  }
  const bad = [
    ...definition.columns.map((c) => c.field),
    ...definition.groups.map((g) => g.field),
    ...definition.totals.map((t) => t.field),
    ...definition.sort.map((k) => k.field),
    ...definition.dataset.filters.map((f) => f.field),
  ].filter((field) => !known.has(field));
  if (bad.length > 0) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `dataset '${definition.dataset.source}' has no such field: ${[...new Set(bad)].join(", ")}`,
    );
  }
}
```

Add to `packages/db/src/reports/index.ts`:

```ts
export {
  assertDefinitionFields, rowsForDefinition, statementRows, type StatementParams,
} from "./statement";
```

- [ ] **Step 5: Run both test files to see them pass**

Run: `bun run --cwd packages/domain test -- reports/statement && bun run --cwd packages/db test -- reports/statement-tie-out`
Expected: PASS — every `it` in both.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/reports/statement.ts packages/domain/src/reports/index.ts \
        packages/domain/test/reports/statement.test.ts packages/domain/test/reports/fixture/statement-rows.json \
        packages/db/src/reports/statement.ts packages/db/src/reports/index.ts \
        packages/db/test/reports/statement-tie-out.test.ts
git commit -m "$(cat <<'EOF'
feat(domain): add the balance-sheet and P&L layouts, per BRANCH [7A T9]

STATEMENT_LAYOUTS is a fragment pair with no code, name or module, because
§4.16.1 makes the LAYOUT 7A's and the DEFINITION 7B's — 7A seeds no report.
statementSectionFor is total over the five account_type labels with no default
arm. Both statements read account_balance, the projection 1B's trial balance
reads, and the tie-out test proves balance-sheet net + P&L net = 0 to the cent.
perBranch reads ledger_entry instead, because account_balance has no branch key.

STATEMENT_CODES is the binding that tells a run path a definition is a statement,
and rowsForDefinition / assertDefinitionFields are the one row provider and the
one field check T11, T13 and T14 all go through: without them statementRows would
be unreachable outside its own test and every statement definition would be
refused by the field check for naming `section`.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The three renderers, the worker's engine seam and the object store — test 23 re-run

§4.11.2 puts the engine adapters in `apps/worker`: "PDF per ADR 0016, ExcelJS, CSV". This task ships all three behind one `ReportRenderer` seam, the two PDF **source builders** in `packages/domain` (pure text, so both directions are unit-testable without a browser), the worker's `ObjectStore` accessor, and the test-23 re-run through §4.17.1's `pdfText`.

**Why the worker has its own PDF adapters.** 2C ships `engineFor`, `chromiumEngine` and `typstEngine` in `apps/api/src/print/engines/`, and §3.1 is unambiguous: "`api`, `worker`, `pos`, `backoffice` import from packages, **never from each other**". Moving them into a package is not open either — `engineFor` throws `AppError` from `@dulja/contracts`, and `packages/db` may not import that. So the worker re-implements the *invocation* (a `typst compile` child process, a Playwright `page.pdf()`), against **the same ADR-0016 codes and the same paper vocabulary**, and ADR 0066 records the duplication as forced rather than accidental. Hazard 30 is respected: no engine is re-evaluated, and `react-pdf` has no adapter here either, for exactly ADR 0032's reason.

**Money in a spreadsheet cell.** ExcelJS accepts a JS `number` or a string. A `number` would put a monetary value in a float — spec:2041's "No `number` type ever holds a monetary value", and 0D's `no-number-money` lint covers `apps/**`. So a money, quantity or percent cell receives the **4- or 6-decimal string** with `numFmt` set for display. The consequence is stated in ADR 0066: Excel shows "number stored as text" and in-sheet `SUM()` needs a `VALUE()`, which is the price of not lying about precision; the CSV carries the same raw strings and 7C's tenant export is the machine-readable path.

**Files:**
- Create: `packages/domain/src/reports/pdf-source.ts`, `packages/domain/test/reports/pdf-source.test.ts`, `apps/worker/src/object-store.ts`, `apps/worker/src/reports/formatters.ts`, `apps/worker/src/reports/renderers/index.ts`, `apps/worker/src/reports/renderers/csv.ts`, `apps/worker/src/reports/renderers/xlsx.ts`, `apps/worker/src/reports/renderers/pdf.ts`, `apps/worker/src/reports/engines/index.ts`, `apps/worker/src/reports/engines/typst.ts`, `apps/worker/src/reports/engines/chromium.ts`, `apps/worker/test/reports/renderers.test.ts`, `apps/worker/test/reports/pdf.test.ts`, `docs/adr/0066-server-side-report-render.md`
- Modify: `packages/domain/src/reports/index.ts`, `apps/worker/package.json`, `infra/secrets.ts`, `infra/test/secrets.test.ts`, `scripts/lint/rules/dependency-rule.ts` (0B, widened by 1B), `apps/worker/tsconfig.json`, `apps/api/tsconfig.json`

**Interfaces:**
- Consumes: `RenderedReport`, `RenderedRow`, `RenderedColumn`, `renderCsv`, `renderReport`, `intlFormatters`, `ReportFormat`, `ReportLang`, `ReportPaper`, `ReportOrientation` (Task 8); `htmlEscape`, `typstEscape` from `@dulja/domain`'s print module (**2C** — reused, never re-spelled); `formatDate`, `formatNumber`, `formatMoney`, `formatQuantity`, `type FormatContext`, `dirFor` from `@dulja/i18n` (0E); `ObjectStore`, `MemoryObjectStore`, `R2ObjectStore`, `type R2ObjectStoreOptions` from `@dulja/db` (§4.5.8, 2C); `log`, `setLogger` from `apps/worker/src/log.ts` (0D); `pdfText` from `tests/support/pdf.ts` (§4.17.1, 2C); `containerSecrets` from `infra/secrets.ts` (0C).
- Produces:

```ts
// packages/domain/src/reports/pdf-source.ts — pure text; both directions from ONE report value
export function reportToHtmlSource(report: RenderedReport): string;
export function reportToTypstSource(report: RenderedReport): string;

// apps/worker/src/object-store.ts — the worker's twin of 0D's log()/setLogger()
export function objectStore(): ObjectStore;                        // throws if unset
export function setObjectStore(store: ObjectStore): void;
export function objectStoreFromEnv(env: NodeJS.ProcessEnv): ObjectStore;   // MemoryObjectStore when no R2 names are set

// apps/worker/src/reports/formatters.ts
export function i18nFormatters(lang: ReportLang, opts?: { currency?: string; timeZone?: string }): ReportFormatters;

// apps/worker/src/reports/engines/index.ts
export type ReportPdfEngineCode = "typst" | "chromium";            // the two ADR-0016 codes with a text adapter
export interface ReportPdfEngine {
  readonly code: ReportPdfEngineCode;
  available(): Promise<boolean>;
  render(source: string, opts: { paper: ReportPaper; orientation: ReportOrientation; dir: "ltr" | "rtl" }): Promise<Uint8Array>;
}
export const REPORT_PDF_ENGINES: Readonly<Record<ReportPdfEngineCode, ReportPdfEngine>>;
export const REPORT_PDF_ENGINE_ORDER: readonly ReportPdfEngineCode[];   // ["typst", "chromium"]
export const PDF_MAGIC: Uint8Array;                                     // "%PDF-"
export async function reportPdfEngine(code?: string): Promise<ReportPdfEngine>;   // AppError ERR_PRINT_ENGINE_UNSUPPORTED
export function resetReportPdfEngine(): void;                            // clears the memoised resolution (tests)

// apps/worker/src/reports/renderers/index.ts
export interface RenderedArtefact { bytes: Uint8Array; contentType: string; extension: string }
export interface ReportRenderer { readonly format: ReportFormat; render(report: RenderedReport): Promise<RenderedArtefact> }
export const REPORT_RENDERERS: Readonly<Record<ReportFormat, ReportRenderer>>;
export function rendererFor(format: string): ReportRenderer;             // AppError ERR_VALIDATION_FAILED
export const REPORT_CONTENT_TYPE: Readonly<Record<ReportFormat, string>>;
export const REPORT_EXTENSION: Readonly<Record<ReportFormat, string>>;   // { pdf: "pdf", xlsx: "xlsx", csv: "csv" }
```

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/reports/pdf-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  intlFormatters, renderReport, reportToHtmlSource, reportToTypstSource, type ReportDefinition,
} from "../../src/reports";

function def(): ReportDefinition {
  return {
    version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
    module: "accounting", permission: "accounting.report.read", parameters: [],
    dataset: { source: "account_balance", filters: [] },
    columns: [
      { field: "c", labelEn: "Code <b>", labelAr: "الرمز", format: "text", align: "start" },
      { field: "v", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
    ],
    groups: [], totals: [{ field: "v", fn: "sum" }], sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "p" },
    tieOut: { kind: "none" },
  };
}
const ROWS = [{ c: "1000 & Co", v: "1.5000", currency: "MYR" }];
const en = () => renderReport(def(), ROWS, { format: "pdf", lang: "en", formatters: intlFormatters("en"), generatedAt: "2026-03-31T08:00:00Z" });
const ar = () => renderReport(def(), ROWS, { format: "pdf", lang: "ar", formatters: intlFormatters("ar"), generatedAt: "2026-03-31T08:00:00Z" });

describe("reportToHtmlSource", () => {
  it("escapes every label and cell through 2C's htmlEscape — a report cannot inject markup", () => {
    const html = reportToHtmlSource(en());
    expect(html).toContain("Code &lt;b&gt;");
    expect(html).toContain("1000 &amp; Co");
    expect(html).not.toContain("<b>");
  });

  it("sets dir and lang on <html> and uses logical CSS properties only (spec:2253, 0E's rule)", () => {
    expect(reportToHtmlSource(en())).toContain('<html lang="en" dir="ltr">');
    expect(reportToHtmlSource(ar())).toContain('<html lang="ar" dir="rtl">');
    const html = reportToHtmlSource(ar());
    for (const physical of ["margin-left", "margin-right", "padding-left", "padding-right", "text-align: left", "text-align: right"]) {
      expect(html, physical).not.toContain(physical);
    }
    expect(html).toContain("text-align: end");
  });

  it("references no external URL, so the render fetches nothing and stays deterministic", () => {
    const html = reportToHtmlSource(ar());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
  });

  it("marks the subtotal and total rows with a class a reviewer can see in the diff", () => {
    expect(reportToHtmlSource(en())).toContain('class="row total"');
  });

  it("is byte-deterministic for one report value", () => {
    const r = en();
    expect(reportToHtmlSource(r)).toBe(reportToHtmlSource(r));
  });
});

describe("reportToTypstSource", () => {
  it("passes dir and paper as inputs, escapes through 2C's typstEscape, and is deterministic", () => {
    const src = reportToTypstSource(ar());
    expect(src).toContain('#let dir = sys.inputs.at("dir", default: "rtl")');
    expect(src).toContain("text.dir");
    expect(src).not.toContain("#image(");         // no external asset
    expect(reportToTypstSource(ar())).toBe(src);
  });

  it("carries the Arabic title and every Arabic label", () => {
    const src = reportToTypstSource(ar());
    expect(src).toContain("ميزان المراجعة");
    expect(src).toContain("مدين");
  });
});
```

`apps/worker/test/reports/renderers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { intlFormatters, renderReport, type ReportDefinition } from "@dulja/domain";
import { REPORT_EXTENSION, rendererFor } from "../../src/reports/renderers";
import { i18nFormatters } from "../../src/reports/formatters";

function def(): ReportDefinition {
  return {
    version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
    module: "accounting", permission: "accounting.report.read", parameters: [],
    dataset: { source: "account_balance", filters: [] },
    columns: [
      { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start", width: 80 },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
    ],
    groups: [], totals: [{ field: "base_debit", fn: "sum" }], sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "{rowCount}" },
    tieOut: { kind: "none" },
  };
}
const ROWS = [
  { account_code: "1000", base_debit: "120.5000", currency: "MYR" },
  { account_code: "1200", base_debit: "400.0000", currency: "MYR" },
];
const report = (lang: "en" | "ar") =>
  renderReport(def(), ROWS, { format: "xlsx", lang, formatters: i18nFormatters(lang, { currency: "MYR" }), generatedAt: "2026-03-31T08:00:00Z" });

describe("the renderer registry", () => {
  it("holds exactly the three formats, with their content types and extensions", () => {
    expect(Object.keys(REPORT_EXTENSION).sort()).toEqual(["csv", "pdf", "xlsx"]);
    expect(rendererFor("csv").format).toBe("csv");
    expect(() => rendererFor("docx")).toThrowError(/format 'docx' is not one of csv, pdf, xlsx/);
  });
});

describe("the CSV renderer", () => {
  it("emits UTF-8 with a BOM and text/csv, and the bytes round-trip to the same string", async () => {
    const a = await rendererFor("csv").render(report("ar"));
    expect(a.contentType).toBe("text/csv; charset=utf-8");
    expect(a.extension).toBe("csv");
    const text = new TextDecoder().decode(a.bytes);
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("1000,120.5000");
    const again = await rendererFor("csv").render(report("ar"));
    expect(again.bytes).toEqual(a.bytes);
  });
});

describe("the XLSX renderer", () => {
  it("writes the header row, sets rightToLeft for ar, and never puts money in a JS number", async () => {
    const artefact = await rendererFor("xlsx").render(report("ar"));
    expect(artefact.contentType)
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(artefact.bytes) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect(ws.getRow(1).values).toEqual([undefined, "الرمز", "مدين"]);
    const money = ws.getRow(2).getCell(2);
    // spec:2041: no `number` type ever holds a monetary value, and 0D's no-number-money lint covers apps/**.
    expect(typeof money.value).toBe("string");
    expect(money.value).toBe("120.5000");
    expect(money.numFmt).toBe("#,##0.0000");
    expect(money.alignment?.horizontal).toBe("right");
  });

  it("uses left alignment and no rightToLeft for en, and freezes the header row", async () => {
    const artefact = await rendererFor("xlsx").render(report("en"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(artefact.bytes) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.views[0]?.rightToLeft).toBeFalsy();
    expect(ws.views[0]?.state).toBe("frozen");
    expect(ws.views[0]?.ySplit).toBe(1);
    expect(ws.getRow(2).getCell(1).alignment?.horizontal).toBe("left");
  });

  it("bolds the total row so a reader can find it without the colour", async () => {
    const artefact = await rendererFor("xlsx").render(report("en"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(artefact.bytes) as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(4).getCell(2).font?.bold).toBe(true);
    expect(ws.getRow(4).getCell(2).value).toBe("520.5000");
  });
});

describe("i18nFormatters", () => {
  it("delegates to @dulja/i18n, so the numeral and calendar policy stays 0E's", () => {
    // The Hijri calendar for ar is 0E's FormatContext default, not a decision made in this slice.
    expect(i18nFormatters("ar").date("2026-01-15")).not.toBe(intlFormatters("en").date("2026-01-15"));
    expect(i18nFormatters("en").money({ amount: "1234.5000", currency: "MYR" })).toContain("1,234.50");
  });
});
```

`apps/worker/test/reports/pdf.test.ts` — the **test 23 re-run** (spec:2253, contracts §6.1 "23 → every generated PDF"):

```ts
import { afterAll, describe, expect, it } from "vitest";
import { intlFormatters, renderReport, type ReportDefinition } from "@dulja/domain";
import { pdfText } from "../../../../tests/support/pdf";
import { PDF_MAGIC, REPORT_PDF_ENGINE_ORDER, reportPdfEngine, resetReportPdfEngine } from "../../src/reports/engines";
import { rendererFor } from "../../src/reports/renderers";
import { i18nFormatters } from "../../src/reports/formatters";

function def(): ReportDefinition {
  return {
    // `ledger_entry` rather than `account_balance`, because test 23's clause is "numerals, **Hijri/Gregorian
    // dates** and column order" and only the ledger dataset carries a date column (§4.16.2). A definition
    // with no `date` column could never exercise the calendar half of spec:2253 at all.
    version: 1, code: "accounting.ledger", nameEn: "Ledger", nameAr: "دفتر الأستاذ",
    module: "accounting", permission: "accounting.report.read", parameters: [],
    dataset: { source: "ledger_entry", filters: [] },
    columns: [
      { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
      { field: "account_name_en", labelEn: "Name", labelAr: "الاسم", format: "text", align: "start" },
      { field: "effective_date", labelEn: "Date", labelAr: "التاريخ", format: "date", align: "start" },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
    ],
    groups: [], totals: [{ field: "base_debit", fn: "sum" }], sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "{rowCount}" },
    tieOut: { kind: "none" },
  };
}
const ON = "2026-01-15";
const ROWS = [{
  account_code: "1000", account_name_en: "Cash", effective_date: ON, base_debit: "120.5000", currency: "MYR",
}];

/**
 * A PDF engine may split one logical cell across several text items, and `Intl`'s Arabic output carries bidi
 * control characters (RLM, ALM, the isolate marks) that a PDF text layer may keep, drop or move. Neither is
 * what test 23 asserts — the assertion is the DIGITS and the CALENDAR — so both sides of every comparison
 * below are stripped of whitespace and of those controls before they meet.
 */
// Spelled as \u escapes, never as the literal characters — an invisible control in a source file is exactly
// the defect Self-Review items 1 and 2 removed from `interpolate` and `groupKey`.
const NOISE = /[\s\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const packed = (text: string[]) => text.join("").replace(NOISE, "");
const strip = (value: string) => value.replace(NOISE, "");

describe("the PDF renderer — Part VI test 23 re-run (spec:2253)", () => {
  afterAll(() => { resetReportPdfEngine(); });

  it("resolves an ADR-0016 engine from the fixed order, and refuses react-pdf by name", async () => {
    expect([...REPORT_PDF_ENGINE_ORDER]).toEqual(["typst", "chromium"]);
    const engine = await reportPdfEngine();
    expect(REPORT_PDF_ENGINE_ORDER).toContain(engine.code);
    await expect(reportPdfEngine("react-pdf")).rejects.toThrowError(
      /react-pdf renders a React component, not template text/);
    await expect(reportPdfEngine("wkhtmltopdf")).rejects.toThrowError(/is not an ADR-0016 engine code/);
  });

  it("renders a real PDF in English with every label and figure in reading order", async () => {
    const r = renderReport(def(), ROWS, { format: "pdf", lang: "en", formatters: i18nFormatters("en", { currency: "MYR" }) });
    const { bytes, contentType } = await rendererFor("pdf").render(r);
    expect(contentType).toBe("application/pdf");
    expect(bytes.slice(0, 5)).toEqual(PDF_MAGIC);
    const text = await pdfText(bytes);
    const joined = text.join(" ");
    expect(joined).toContain("Ledger");
    expect(joined).toContain("Code");
    expect(joined).toContain("Cash");
    expect(joined).toContain("Total");
    expect(text.indexOf("Code")).toBeLessThan(text.indexOf("Debit"));

    // spec:2253's CALENDAR half, English side: the Gregorian rendering `@dulja/i18n` produces, computed here
    // rather than written as a literal so the policy stays 0E's and this test never becomes a second one.
    const en = i18nFormatters("en", { currency: "MYR" });
    expect(packed(text)).toContain(strip(en.date(ON)));
    // …and its NUMERALS: Latin digits in the money cell and in the total.
    expect(packed(text)).toContain(strip(en.money({ amount: "120.5000", currency: "MYR" })));
  });

  it("renders the SAME report in Arabic with the Arabic labels and reversed reading order", async () => {
    const r = renderReport(def(), ROWS, { format: "pdf", lang: "ar", formatters: i18nFormatters("ar", { currency: "MYR" }) });
    const { bytes } = await rendererFor("pdf").render(r);
    const text = await pdfText(bytes);
    const joined = text.join(" ");
    expect(joined).toContain("دفتر الأستاذ");
    expect(joined).toContain("الرمز");
    expect(joined).toContain("مدين");
    expect(joined).toContain("الإجمالي");
    // spec:2253's "column order": in rtl the first logical column is read RIGHTMOST, so `الرمز` comes after
    // `مدين` in reading order. Determinism is asserted at the rendered-TEXT layer, never at the byte layer —
    // Chromium embeds a CreationDate, so no test compares PDF bytes (§4.5.9).
    expect(text.indexOf("مدين")).toBeLessThan(text.indexOf("الرمز"));
  });

  it("carries the Arabic NUMERALS and the Hijri date into the rendered PDF, and the two languages differ", async () => {
    // The other two thirds of test 23's clause, asserted on the BYTES' rendered text rather than on the
    // formatter in isolation: a renderer that dropped `formatters` and stringified the raw row would still
    // pass the label and column-order cases above, and would ship a report with Latin digits and a Gregorian
    // date to an Arabic reader. Both expected strings come from `@dulja/i18n` (`i18nFormatters`), so the
    // numeral system and the calendar stay 0E's `FormatContext` policy and are not re-decided here.
    const ar = i18nFormatters("ar", { currency: "MYR" });
    const en = i18nFormatters("en", { currency: "MYR" });

    const arText = packed(await pdfText((await rendererFor("pdf").render(
      renderReport(def(), ROWS, { format: "pdf", lang: "ar", formatters: ar }))).bytes));
    const enText = packed(await pdfText((await rendererFor("pdf").render(
      renderReport(def(), ROWS, { format: "pdf", lang: "en", formatters: en }))).bytes));

    expect(arText).toContain(strip(ar.date(ON)));                 // Hijri, per 0E's ar FormatContext
    expect(enText).toContain(strip(en.date(ON)));                 // Gregorian
    expect(strip(ar.date(ON))).not.toBe(strip(en.date(ON)));      // the two calendars really differ

    expect(arText).toContain(strip(ar.money({ amount: "120.5000", currency: "MYR" })));
    expect(enText).toContain(strip(en.money({ amount: "120.5000", currency: "MYR" })));
  }, 120_000);

  it("renders every §4.5.9 paper token and both orientations without throwing", async () => {
    for (const paper of ["A4", "A5", "receipt"] as const) {
      for (const orientation of ["portrait", "landscape"] as const) {
        const d = def();
        d.layout = { ...d.layout, paper, orientation };
        const r = renderReport(d, ROWS, { format: "pdf", lang: "en", formatters: intlFormatters("en") });
        const { bytes } = await rendererFor("pdf").render(r);
        expect(bytes.slice(0, 5), `${paper}/${orientation}`).toEqual(PDF_MAGIC);
      }
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/domain test -- reports/pdf-source`
Expected: FAIL — `reportToHtmlSource is not exported by src/reports`.

- [ ] **Step 3: Write the two PDF source builders**

`packages/domain/src/reports/pdf-source.ts`:

```ts
import { htmlEscape, typstEscape } from "../print/escape";
import type { RenderedReport, RenderedRow } from "./render";

/**
 * The two text forms the ADR-0016 engines consume. Both are built from ONE `RenderedReport`, so the English
 * and Arabic outputs of a report can never diverge in structure — which is what makes test 23 a property of
 * the renderer rather than of two hand-kept templates (spec:2253).
 *
 * Escaping goes through 2C's `htmlEscape` / `typstEscape` (`packages/domain/src/print/escape.ts`); a second
 * escaper in this file would be two spellings of one thing (hazard 9).
 */

const PAPER_CSS: Readonly<Record<string, string>> = {
  A4: "A4", A5: "A5", receipt: "80mm 297mm",
};

export function reportToHtmlSource(report: RenderedReport): string {
  const align = (a: "start" | "end") => (a === "end" ? "end" : "start");
  const head = report.columns
    .map((c) => `<th style="text-align: ${align(c.align)}${c.width === null ? "" : `; width: ${c.width}px`}">${htmlEscape(c.label)}</th>`)
    .join("");
  const body = report.rows.map((row: RenderedRow) => {
    const cells = row.cells
      .map((cell, i) => `<td style="text-align: ${align(report.columns[i]!.align)}">${htmlEscape(cell.text)}</td>`)
      .join("");
    return `<tr class="row ${row.kind}">${cells}</tr>`;
  }).join("");
  // Every property below is LOGICAL (`start`/`end`, `margin-block`, `margin-inline`), which is 0E's Tailwind
  // rule applied to a bare stylesheet: a physical `left`/`right` would be correct in one direction only.
  // No external URL, no <link>, no <script> — the renderer must fetch nothing, or two runs differ.
  return `<!doctype html>
<html lang="${htmlEscape(report.lang)}" dir="${report.dir}">
<head><meta charset="utf-8"><title>${htmlEscape(report.title)}</title>
<style>
  @page { size: ${PAPER_CSS[report.paper] ?? "A4"} ${report.orientation}; margin: 12mm; }
  body { font-family: system-ui, sans-serif; font-size: 10pt; margin: 0; }
  h1 { font-size: 14pt; margin-block: 0 4mm; }
  .meta { font-size: 8pt; margin-block-end: 4mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding-block: 1.2mm; padding-inline: 2mm; border-block-end: 0.2mm solid #999; }
  th { text-align: start; font-weight: 600; }
  tr.subtotal td, tr.total td { font-weight: 700; border-block-start: 0.3mm solid #333; }
  tfoot { font-size: 8pt; }
</style></head>
<body>
<h1>${htmlEscape(report.title)}</h1>
<div class="meta">${htmlEscape(report.header)}</div>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="meta">${htmlEscape(report.footer)}</div>
</body></html>`;
}

export function reportToTypstSource(report: RenderedReport): string {
  const cell = (text: string) => `[${typstEscape(text)}]`;
  const head = report.columns.map((c) => cell(c.label)).join(", ");
  const rows = report.rows
    .map((row) => row.cells.map((c) => cell(c.text)).join(", "))
    .join(",\n    ");
  const paper = report.paper === "receipt" ? '"a5"' : `"${report.paper.toLowerCase()}"`;
  const columns = report.columns.map((c) => (c.align === "end" ? "auto" : "1fr")).join(", ");
  // `dir` and `paper` arrive as typst `--input` values, exactly as 2C's adapter passes them, so ONE body
  // serves both directions (spec:2253) and the adapter never rewrites the source.
  return `#let dir = sys.inputs.at("dir", default: "${report.dir}")
#let paper = sys.inputs.at("paper", default: ${paper})
#set page(paper: paper, flipped: ${report.orientation === "landscape" ? "true" : "false"}, margin: 12mm)
#set text(size: 10pt, dir: if dir == "rtl" { rtl } else { ltr })
#set par(justify: false)
= ${typstEscape(report.title)}
#text(size: 8pt)[${typstEscape(report.header)}]
#v(4mm)
#table(
  columns: (${columns}),
  align: (${report.columns.map((c) => (c.align === "end" ? "right" : "left")).join(", ")}),
  table.header(${head}),
    ${rows}
)
#v(4mm)
#text(size: 8pt)[${typstEscape(report.footer)}]
`;
}
```

Add `export * from "./pdf-source";` to `packages/domain/src/reports/index.ts`.

- [ ] **Step 4: Write the worker's object store and formatters**

`apps/worker/src/object-store.ts`:

```ts
import { MemoryObjectStore, R2ObjectStore, type ObjectStore } from "@dulja/db";

/**
 * The worker's twin of 0D's `log()` / `setLogger()`. A job handler needs a store to write a rendered report
 * into, and §3.1 forbids importing `apps/api/src/object-store.ts`; a module-level accessor keeps
 * `StartedWorker` (§4.17.1) untouched — a test calls `setObjectStore(new MemoryObjectStore())` before
 * `startWorker()`.
 */
let current: ObjectStore | null = null;

export function setObjectStore(store: ObjectStore): void { current = store; }

export function objectStore(): ObjectStore {
  if (current === null) {
    throw new Error("objectStore() called before setObjectStore(); apps/worker/src/index.ts wires it at boot");
  }
  return current;
}

/**
 * The four §3.11 R2 names. All four present → R2; none present → in-memory (what `bun run dev` and CI use);
 * some present → a configuration error naming the missing one, like every other value in §3.11.
 * `containerSecrets(env, "worker")` is what puts them in the worker container (this task's `infra` edit).
 */
export function objectStoreFromEnv(env: NodeJS.ProcessEnv): ObjectStore {
  const names = ["R2_ACCOUNT_ID", "R2_ATTACHMENTS_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
  const values = names.map((n) => env[n]);
  if (values.every((v) => v === undefined || v === "")) return new MemoryObjectStore();
  const missing = names.filter((n, i) => values[i] === undefined || values[i] === "");
  if (missing.length > 0) {
    throw new Error(`report rendering needs all four R2 variables (§3.11); missing: ${missing.join(", ")}`);
  }
  return new R2ObjectStore({
    accountId: values[0]!, bucket: values[1]!, accessKeyId: values[2]!, secretAccessKey: values[3]!,
  });
}
```

`apps/worker/src/reports/formatters.ts`:

```ts
import { formatDate, formatMoney, formatNumber, formatQuantity, type FormatContext } from "@dulja/i18n";
import type { ReportFormatters, ReportLang } from "@dulja/domain";

/**
 * The production `ReportFormatters`. `packages/domain`'s `intlFormatters` exists so the layout tests need no
 * dependency; THIS is what a rendered report uses, so the numeral system, the Hijri calendar and the money
 * policy are 0E's `FormatContext` and are not re-decided in this slice (spec:2061, spec:2253).
 */
export function i18nFormatters(
  lang: ReportLang,
  opts: { currency?: string; timeZone?: string } = {},
): ReportFormatters {
  const ctx: FormatContext = {
    locale: lang,
    calendar: lang === "ar" ? "islamic-umalqura" : "gregory",
    numberingSystem: "latn",
    timeZone: opts.timeZone ?? "Asia/Kuala_Lumpur",
  };
  return {
    date: (iso) => formatDate(iso, ctx, "medium"),
    number: (decimal, o) => formatNumber(decimal, ctx, o),
    money: (value) => formatMoney({ amount: value.amount, currency: value.currency || opts.currency || "XXX" }, ctx),
    quantity: (decimal) => formatQuantity(decimal, ctx),
    // @dulja/i18n has no percent formatter; a percent column is a plain number with a suffix, and the
    // ratio-to-per-cent multiplication is done as a string shift so no float touches it.
    percent: (decimal) => `${formatNumber(shiftTwo(decimal), ctx, { maximumFractionDigits: 4 })}%`,
  };
}

/** Multiplies a decimal string by 100 by moving the point — no `Number()`, no `Decimal` needed. */
function shiftTwo(decimal: string): string {
  const negative = decimal.startsWith("-");
  const [whole, fraction = ""] = decimal.replace("-", "").split(".");
  const digits = `${whole}${fraction.padEnd(2, "0")}`;
  const rest = fraction.slice(2);
  const shifted = digits.replace(/^0+(?=\d)/, "");
  return `${negative ? "-" : ""}${shifted === "" ? "0" : shifted}${rest === "" ? "" : `.${rest}`}`;
}
```

- [ ] **Step 5: Write the engine seam and the two adapters**

`apps/worker/src/reports/engines/index.ts`:

```ts
import { AppError } from "@dulja/contracts";
import type { ReportOrientation, ReportPaper } from "@dulja/domain";
import { chromiumReportEngine } from "./chromium";
import { typstReportEngine } from "./typst";

/**
 * ADR 0016 fixes the vocabulary `typst | chromium | react-pdf` and hazard 30 forbids re-opening it. Only two
 * of the three can consume TEXT — `react-pdf` renders a React component (2C's ADR 0032) — so those two are
 * the codes a report renderer can use, and `react-pdf` raises `ERR_PRINT_ENGINE_UNSUPPORTED` by name.
 *
 * These adapters duplicate 2C's `apps/api/src/print/engines/*` invocation deliberately: §3.1 forbids
 * `apps/worker` importing `apps/api`, and `engineFor` throws `AppError` so it cannot move into `packages/db`.
 * ADR 0066 records the duplication as forced. The two files stay in step because both are driven by ADR 0016.
 */
export type ReportPdfEngineCode = "typst" | "chromium";

export interface ReportPdfEngine {
  readonly code: ReportPdfEngineCode;
  /** Cheap probe: is the binary or browser present in this image? */
  available(): Promise<boolean>;
  render(source: string, opts: { paper: ReportPaper; orientation: ReportOrientation; dir: "ltr" | "rtl" }): Promise<Uint8Array>;
}

export const REPORT_PDF_ENGINES: Readonly<Record<ReportPdfEngineCode, ReportPdfEngine>> = {
  typst: typstReportEngine,
  chromium: chromiumReportEngine,
};

/** Preference order, not a ranking of quality: typst is a 30 MB binary with no browser to keep warm, so a
 *  worker that has it should use it. ADR 0066 records the order; ADR 0016 records the engines. */
export const REPORT_PDF_ENGINE_ORDER: readonly ReportPdfEngineCode[] = ["typst", "chromium"];

export const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);   // "%PDF-"

let resolved: ReportPdfEngine | null = null;

export function resetReportPdfEngine(): void { resolved = null; }

export async function reportPdfEngine(code?: string): Promise<ReportPdfEngine> {
  if (code !== undefined) {
    const named = (REPORT_PDF_ENGINES as Record<string, ReportPdfEngine | undefined>)[code];
    if (named !== undefined) return named;
    throw new AppError(
      "ERR_PRINT_ENGINE_UNSUPPORTED",
      code === "react-pdf"
        ? "react-pdf renders a React component, not template text; a server-rendered report cannot use it (ADR 0032)"
        : `'${code}' is not an ADR-0016 engine code with a text adapter; the codes are ${REPORT_PDF_ENGINE_ORDER.join(", ")}`,
    );
  }
  if (resolved !== null) return resolved;
  for (const candidate of REPORT_PDF_ENGINE_ORDER) {
    const engine = REPORT_PDF_ENGINES[candidate];
    if (await engine.available()) { resolved = engine; return engine; }
  }
  throw new AppError(
    "ERR_PRINT_ENGINE_UNSUPPORTED",
    `no ADR-0016 PDF engine is available in this image; install the typst binary (TYPST_BIN) or Playwright's chromium`,
  );
}
```

`apps/worker/src/reports/engines/typst.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AppError } from "@dulja/contracts";
import type { ReportPdfEngine } from "./index";

const run = promisify(execFile);

/** `typst` is a binary, not a package — the container image installs it and CI installs it in a step. The
 *  same environment name 2C's adapter reads, so one image serves both. */
export const TYPST_BIN = process.env["TYPST_BIN"] ?? "typst";

export const typstReportEngine: ReportPdfEngine = {
  code: "typst",
  async available() {
    try { await run(TYPST_BIN, ["--version"], { timeout: 10_000 }); return true; }
    catch { return false; }
  },
  async render(source, opts) {
    const dir = await mkdtemp(join(tmpdir(), "dulja-report-"));
    const input = join(dir, "report.typ");
    const output = join(dir, "report.pdf");
    try {
      await writeFile(input, source, "utf8");
      await run(TYPST_BIN, [
        "compile",
        "--input", `dir=${opts.dir}`,
        "--input", `paper=${opts.paper === "receipt" ? "a5" : opts.paper.toLowerCase()}`,
        input, output,
      ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
      return new Uint8Array(await readFile(output));
    } catch (e) {
      throw new AppError("ERR_INTERNAL",
        `typst failed to compile the report: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
```

`apps/worker/src/reports/engines/chromium.ts`:

```ts
import { chromium, type Browser } from "playwright";
import type { ReportPdfEngine } from "./index";

const PAGE: Readonly<Record<string, { format?: "A4" | "A5"; width?: string; height?: string }>> = {
  A4: { format: "A4" }, A5: { format: "A5" }, receipt: { width: "80mm", height: "297mm" },
};

let browser: Browser | null = null;

async function shared(): Promise<Browser> {
  browser ??= await chromium.launch({ args: ["--no-sandbox", "--font-render-hinting=none"] });
  return browser;
}

export async function closeReportChromium(): Promise<void> {
  await browser?.close();
  browser = null;
}

export const chromiumReportEngine: ReportPdfEngine = {
  code: "chromium",
  async available() {
    try { return chromium.executablePath().length > 0; } catch { return false; }
  },
  async render(source, opts) {
    const page = await (await shared()).newPage();
    try {
      // `setContent` never navigates, so the renderer fetches nothing — a report that referenced an external
      // URL would silently produce a different PDF per run. `dir` is already on the <html> element that
      // `reportToHtmlSource` emits; passing it again would let the source and the request disagree.
      await page.setContent(source, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      const size = PAGE[opts.paper] ?? PAGE["A4"]!;
      return new Uint8Array(await page.pdf({
        ...size,
        landscape: opts.orientation === "landscape" && opts.paper !== "receipt",
        printBackground: true,
        preferCSSPageSize: false,
      }));
    } finally {
      await page.close();
    }
  },
};
```

- [ ] **Step 6: Write the three renderers**

`apps/worker/src/reports/renderers/csv.ts`:

```ts
import { renderCsv } from "@dulja/domain";
import type { RenderedArtefact, ReportRenderer } from "./index";

export const csvRenderer: ReportRenderer = {
  format: "csv",
  async render(report) {
    // The BOM is on, because the reader is an accountant opening the file in Excel and Excel needs it to
    // sniff UTF-8 Arabic (ADR 0066). 7C's tenant export is the machine-readable path and does not use this.
    const bytes = new TextEncoder().encode(renderCsv(report, { bom: true }));
    return { bytes, contentType: "text/csv; charset=utf-8", extension: "csv" } satisfies RenderedArtefact;
  },
};
```

`apps/worker/src/reports/renderers/xlsx.ts`:

```ts
import ExcelJS from "exceljs";
import type { ReportColumnFormat } from "@dulja/domain";
import type { RenderedArtefact, ReportRenderer } from "./index";

/** Display formats only. The cell VALUE is always the stored decimal string (spec:2041, ADR 0066). */
const NUM_FMT: Readonly<Record<ReportColumnFormat, string | undefined>> = {
  money: "#,##0.0000", quantity: "#,##0.000000", percent: "0.0000%", integer: "#,##0",
  text: undefined, date: undefined,
};

export const xlsxRenderer: ReportRenderer = {
  format: "xlsx",
  async render(report) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Dulja";
    // A fixed created/modified stamp keeps two renders of one report comparable; the workbook is otherwise
    // deterministic and `report.generatedAt` is the figure a reader sees.
    wb.created = new Date(report.generatedAt);
    wb.modified = new Date(report.generatedAt);
    const ws = wb.addWorksheet(report.title.slice(0, 31), {
      views: [{
        state: "frozen", ySplit: 1,
        rightToLeft: report.dir === "rtl",         // spec:2253 — direction, never a reversed column array
      }],
      pageSetup: {
        paperSize: report.paper === "A5" ? 11 : 9,     // ECMA-376: 9 = A4, 11 = A5
        orientation: report.orientation,
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      },
      headerFooter: { oddHeader: report.header, oddFooter: report.footer },
    });

    ws.columns = report.columns.map((c) => ({
      header: c.label,
      key: c.field,
      width: c.width === null ? 18 : Math.max(8, Math.round(c.width / 7)),
      style: {
        numFmt: NUM_FMT[c.format],
        alignment: { horizontal: c.align === "end" ? "right" : "left" },
      },
    }));
    ws.getRow(1).font = { bold: true };

    for (const row of report.rows) {
      // The RAW value, as a string for every numeric format: a JS number here would put money in a float,
      // which spec:2041 forbids and 0D's no-number-money lint catches in apps/**.
      const added = ws.addRow(Object.fromEntries(row.cells.map((cell, i) => [
        report.columns[i]!.field,
        cell.raw === null ? null : String(cell.raw),
      ])));
      if (row.kind !== "data") added.font = { bold: true };
    }

    const buffer = await wb.xlsx.writeBuffer();
    return {
      bytes: new Uint8Array(buffer as ArrayBuffer),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
    } satisfies RenderedArtefact;
  },
};
```

`apps/worker/src/reports/renderers/pdf.ts`:

```ts
import { reportToHtmlSource, reportToTypstSource } from "@dulja/domain";
import { reportPdfEngine } from "../engines";
import type { RenderedArtefact, ReportRenderer } from "./index";

export const pdfRenderer: ReportRenderer = {
  format: "pdf",
  async render(report) {
    const engine = await reportPdfEngine(process.env["REPORT_PDF_ENGINE"]);
    const source = engine.code === "typst" ? reportToTypstSource(report) : reportToHtmlSource(report);
    const bytes = await engine.render(source, {
      paper: report.paper, orientation: report.orientation, dir: report.dir,
    });
    return { bytes, contentType: "application/pdf", extension: "pdf" } satisfies RenderedArtefact;
  },
};
```

**`REPORT_PDF_ENGINE` is a development override, not a §3.11 row.** It is read once, `undefined` in every deployed environment (so the fixed order picks the engine), and its only purpose is letting `apps/worker/test/reports/pdf.test.ts` be re-run against the other engine on a developer machine. It is deliberately **not** added to §3.11 or to `containerSecrets`: a container that needed it would mean the order is wrong, which is an ADR-0066 amendment rather than a variable.

`apps/worker/src/reports/renderers/index.ts`:

```ts
import { AppError } from "@dulja/contracts";
import { REPORT_FORMATS, type RenderedReport, type ReportFormat } from "@dulja/domain";
import { csvRenderer } from "./csv";
import { pdfRenderer } from "./pdf";
import { xlsxRenderer } from "./xlsx";

export interface RenderedArtefact { bytes: Uint8Array; contentType: string; extension: string }

export interface ReportRenderer {
  readonly format: ReportFormat;
  render(report: RenderedReport): Promise<RenderedArtefact>;
}

export const REPORT_RENDERERS: Readonly<Record<ReportFormat, ReportRenderer>> = {
  csv: csvRenderer, pdf: pdfRenderer, xlsx: xlsxRenderer,
};

export const REPORT_CONTENT_TYPE: Readonly<Record<ReportFormat, string>> = {
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const REPORT_EXTENSION: Readonly<Record<ReportFormat, string>> = { csv: "csv", pdf: "pdf", xlsx: "xlsx" };

export function rendererFor(format: string): ReportRenderer {
  const renderer = (REPORT_RENDERERS as Record<string, ReportRenderer | undefined>)[format];
  if (renderer === undefined) {
    throw new AppError(
      "ERR_VALIDATION_FAILED",
      `report format '${format}' is not one of ${[...REPORT_FORMATS].sort().join(", ")}`,
    );
  }
  return renderer;
}
```

Add `exceljs`, `playwright` and `@dulja/i18n` to `apps/worker/package.json`'s `dependencies` **with no version literal** — `bun add --cwd apps/worker exceljs playwright @dulja/i18n` writes them and the lockfile owns the versions (spec:104, D22).

- [ ] **Step 7: Add the four R2 names to the worker's container environment**

In `infra/secrets.ts`, `containerSecrets(env, entrypoint)` currently gives the four `R2_*` names to the `api` class only (§3.11 lists their holder as `api`, because 2C's attachment upload was the only consumer). The `reporting.render` job writes a rendered report through the same store, so the `worker` class needs them too:

```ts
  // 7A: the reporting.render job writes the rendered artefact through the same ObjectStore port 2C's
  // attachments use, so the worker class needs the same four names. §3.11's "Holder" column for
  // R2_ACCOUNT_ID / R2_ATTACHMENTS_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY becomes "api, worker".
  // Optional when APP_ENV=dev (objectStoreFromEnv returns MemoryObjectStore); a missing one in staging or
  // production is a startup error naming the variable, exactly as it is for apps/api.
```

and in `infra/test/secrets.test.ts` extend the worker-environment expectation to include the four names. `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL_MIGRATOR`, `LEGACY_ODBC_DSN` and `LEGACY_MPOS_DSN` stay excluded from both classes — that exclusion is unchanged.

- [ ] **Step 8: Widen the test-tier import allowance to `tests/support/**`**

Step 1's `apps/worker/test/reports/pdf.test.ts` imports `pdfText` from `tests/support/pdf.ts`, and Task 12's
`apps/api/test/routes/accounting/report-runs.test.ts` imports `problemOf` from `tests/support/api.ts`. Both
are code under `apps/**` reaching the `tests` workspace by relative path, and 0B's `dependency-rule` has no
allow-list: it resolves every relative specifier and reports any result that does not start with the
importing workspace's own prefix (0B's `resolveRelative`). **1B's allowance does not cover these**, because
both of its halves are narrow on purpose — importer `apps/*/test/**`, imported `tests/invariants/support/**`
— and `tests/support/**` is a different directory.

**Verify first, and grep for the CONSTANT, not for the path.** 2C's own `apps/api/test` files import
`grantAdmin` from `tests/support/api.ts` (2C:1363, 3460, 4624), so this widening may already be in the file:

```bash
grep -n "TEST_TIER_SHARED" scripts/lint/rules/dependency-rule.ts
```

**`grep "tests/support"` is the wrong probe and will mislead you.** 0B's own `TIER` object carries the prose
comment "…and `tests/support/ledger.ts` is outside every lint root for the same reason" (0B:5067), so that
string is present on a clean head and a grep for it prints a hit that means nothing. A hit on prose is not an
allowance. If `TEST_TIER_SHARED` is already there covering both directories, **make no change** — add only
the tsconfig lines below and go to Step 9.

**What 1B actually left behind, and why this step writes the guard rather than extending it.** 1B added two
allowances to this file in prose — Task 6 Step 1(b) for `apps/*/test/**` → `tests/invariants/support/**`, and
Task 8 Step 3 for `tests/**` → `apps/worker/src/handlers/**` — but **neither task writes the guard's code**:
each supplies the comment and the reason and says to "add the allowed prefixes explicitly". So the concrete
shape is still open, and the second of the two is a no-op in the rule anyway (`run.ts` walks `apps`,
`packages` and `scripts` only, so no `tests/**` file is ever a `f.path` and the `tests` tier has no `TIER`
row — 0B says so on the row it deliberately omitted). **Reconcile whatever is there into this one shape**,
carrying 1B's comment text across unchanged so its reason is not lost:

```ts
// Test tier to test tier, both shared directories. `tests/invariants/support/**` holds `postJournal` (1B);
// `tests/support/**` holds the helpers that need a running process - `pdfText` (2C), `problemOf` /
// `grantAdmin` / `sharedApi` (0B). Both are test code, and an app's own `test/**` may reach either for the
// same reason: one reader of a PDF and one Problem parser, not two. §4.17.1 registers every helper in both
// directories by name, which is what keeps this from becoming a general escape hatch.
// PRODUCTION code under apps/*/src/** and packages/**/src/** still imports nothing from tests/, and no
// directory under tests/ other than these two is reachable from anywhere.
const TEST_TIER_SHARED = [/^tests\/invariants\/support\//, /^tests\/support\//];
```

The relative-escape branch is 0B's third `if` inside the `forEach` (0B:5105). Replace it in full — the
importer half stays as narrow as 1B intended, and the `resolveRelative` call is hoisted only so the guard can
read it:

```ts
        if (/^\.\.?\//.test(spec)) {
          const resolved = resolveRelative(f.path, spec);
          const testTierToTestTier = /^apps\/[a-z-]+\/test\//.test(f.path)
            && TEST_TIER_SHARED.some((d) => d.test(resolved));
          if (!resolved.startsWith(`${owner}/`) && !testTierToTestTier) {
            out.push({ file: f.path, line: i + 1, rule: this.name, detail: `${owner} reaches outside its own workspace by relative path (spec:2389)` });
          }
        }
```

If the branch you find already differs from 0B's original, keep its `detail` string byte-for-byte — 0B's own
lint test asserts on it.

**`apps/worker/tsconfig.json`** — the helper is outside the app's directory, so `include` gains one line
beside the `tests/invariants/support/**/*.ts` entry 1B added:

```json
    "../../tests/support/**/*.ts"
```

Do the same in **`apps/api/tsconfig.json`** for Task 12 (add it now, in the one task that touches this file,
so Task 12 edits no config). If either `typecheck` reports **TS6059** (`File … is not under 'rootDir'`),
delete that app's `rootDir` line exactly as 1B's Task 6 Step 1(c) instructs and re-run.

**No `package.json` dependency in this direction, ever.** `tests/package.json` already depends on
`@dulja/api` and `@dulja/worker`; the reverse edge would close a cycle in the workspace graph every turbo
pipeline walks (`dependsOn: ["^build"]`, plan0A:262–264). The lint allowance and the tsconfig `include` are
the whole of what is needed — Vitest resolves the relative path without a manifest entry.

Run: `bun run lint:rules && bun run --cwd apps/worker typecheck`
Expected: both green. If `dependency-rule` still reports the `pdf.test.ts` line, the importer regex did not
match — check that it is `apps/worker/test/reports/pdf.test.ts` and not a path with a different segment
count, because the guard is anchored on `apps/<app>/test/`.

- [ ] **Step 9: Run everything to see it pass**

Run: `bun run --cwd packages/domain test -- reports/pdf-source && bun run --cwd apps/worker test -- reports/renderers && bun run --cwd infra test`
Expected: PASS.

Run: `bun run --cwd apps/worker test -- reports/pdf`
Expected: PASS. **If neither engine is available** (no `typst` on `PATH`, no Playwright browser downloaded), `reportPdfEngine()` throws `ERR_PRINT_ENGINE_UNSUPPORTED` and every `it` fails with that message. That is the correct signal, not a test to skip: test 23 is an acceptance test and an image that cannot render a PDF cannot pass it. Install one — `bunx playwright install chromium` or the image's `typst` step — and re-run.

- [ ] **Step 10: Write ADR 0066**

`docs/adr/0066-server-side-report-render.md`:

```markdown
# ADR 0066 — Server-side report render: one layout, three renderers, a worker-local engine adapter

- **Status:** Accepted
- **Date:** 2026-09-05
- **Slice:** 7A
- **Supersedes / superseded by:** consumes ADR 0016 (PDF engine) and ADR 0032 (react-pdf has no text adapter);
  neither is re-opened (contracts hazard 30).

## Context

spec:2293 asks for "server-side render (PDF/XLSX/CSV)"; spec:2206 for async job semantics with a status
resource; spec:2253 for RTL/LTR parity on "every screen and every generated PDF, including numerals, Hijri
and Gregorian dates, and column order". contracts §4.11.2 places the layout in
`packages/domain/src/reports/render.ts` and the engine adapters in `apps/worker`. §3.1 forbids `apps/worker`
importing `apps/api`, where 2C's `engineFor` lives.

## Decision

1. **One layout, three renderers.** `renderReport` produces a `RenderedReport` value object; each renderer
   turns that one value into bytes. Direction, labels, grouping, subtotals and totals are decided once, so
   the English and Arabic outputs of a report cannot diverge in structure and test 23 becomes a property of
   the renderer rather than of two hand-kept templates.
2. **Direction is carried by `dir`, never by reversing the column array.** Reversing *and* setting `dir`
   double-flips. `RenderedReport.columns` is logical order in both languages; the HTML sets `dir` on `<html>`,
   typst sets `text.dir`, and ExcelJS sets `rightToLeft` on the sheet view.
3. **The worker ships its own `typst` and `chromium` adapters.** §3.1 forbids importing `apps/api`, and 2C's
   `engineFor` throws `AppError` from `@dulja/contracts`, which `packages/db` may not import — so there is no
   shared home. The duplication is forced, not accidental: both files are driven by ADR 0016's vocabulary and
   the same `TYPST_BIN` name, and `react-pdf` is absent from both for ADR 0032's reason. Engine selection is a
   fixed order (`typst`, then `chromium`) resolved once per process by an `available()` probe;
   `REPORT_PDF_ENGINE` is a developer override and deliberately not a §3.11 row.
4. **Totals aggregate in `Decimal` at the column's scale; `avg` rounds `HALF_EVEN`.** Money is scale 4,
   quantity 6, percent 6, integer 0. `sum` is exact. §4.2.1 forbids implicit rounding, so the mode is named.
5. **A spreadsheet cell holds the decimal STRING, with `numFmt` for display.** spec:2041: "No `number` type
   ever holds a monetary value", and 0D's `no-number-money` lint covers `apps/**`. The cost is that Excel
   shows "number stored as text" and an in-sheet `SUM()` needs `VALUE()`. That is accepted: a float in a
   monetary cell is the LEGACY-008 defect (a unit cost of 500,020.00 from a `double precision` residue), and the
   CSV carries the same raw strings while 7C's tenant export is the machine-readable path.
6. **Determinism is asserted at the rendered-TEXT layer, never at the byte layer.** Chromium embeds a
   `CreationDate`; §4.5.9 already settled this for 2C's print path and the same rule binds here. The source
   builders *are* byte-deterministic and are asserted as such, and `pdfText` (§4.17.1) is the one test-side
   PDF reader.
7. **The rendered bytes go to the `ObjectStore` port** (§4.5.8, ADR 0031), so `MemoryObjectStore` serves
   tests and `bun run dev` and `R2ObjectStore` serves the container. `containerSecrets(env, "worker")` gains
   the four `R2_*` names in the same PR.

## Consequences

- A worker image must carry one of the two engines. The container step is the image's, not this plan's, and
  `reportPdfEngine()` fails loudly with `ERR_PRINT_ENGINE_UNSUPPORTED` naming both options if neither is there.
- `apps/worker` gains `exceljs`, `playwright` and `@dulja/i18n`. `playwright` is already a repository-level
  test dependency (0E's e2e project), so the marginal image cost is the browser, which the `typst` path avoids.
```

- [ ] **Step 11: Commit**

```bash
git add packages/domain/src/reports/pdf-source.ts packages/domain/src/reports/index.ts \
        packages/domain/test/reports/pdf-source.test.ts apps/worker/src/object-store.ts \
        apps/worker/src/reports apps/worker/test/reports apps/worker/package.json \
        infra/secrets.ts infra/test/secrets.test.ts \
        scripts/lint/rules/dependency-rule.ts apps/worker/tsconfig.json apps/api/tsconfig.json \
        docs/adr/0066-server-side-report-render.md
git commit -m "$(cat <<'EOF'
feat(worker): add the CSV, XLSX and PDF renderers and the engine seam [7A T10]

One RenderedReport drives all three, so English and Arabic cannot diverge in
structure (test 23 re-run through pdfText). Direction is carried by `dir` and
never by a reversed column array. A money cell holds the 4-dp string with numFmt
set, never a JS number (spec:2041). The worker's typst and chromium adapters
duplicate 2C's invocation because §3.1 forbids importing apps/api; ADR 0066
records that and the fixed engine order. containerSecrets gains the four R2
names for the worker class. dependency-rule's test-tier allowance widens to
tests/support/** so an app's own test/** can reach the one PDF reader and the
one Problem parser; production code still imports nothing from tests/.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The `reporting.render` job — the `report_run` lifecycle, the handler, the payload and the probe

`reporting.render` is already in the closed sixteen-name `JOBS` registry (§4.2.6, `schedule: null`, `owner: "7A"`), so this task adds a payload key, a handler, a `startWorker` registration and a `JOB_PROBES` entry — and the `report_run` store the handler drives.

**Four rules from §4.2.6 and hazard 20 the handler follows literally.** It runs as the tenant's **system principal** through `systemContext`; it does its work as **many short `withTenant` transactions**, never one long one (a render can take seconds and must not hold a transaction open across a child process); it is **idempotent under re-delivery** — pg-boss retries three times by default, and the `queued → running` move is a conditional `update` so the second delivery finds no row and returns; and a failure is **recorded on the run**, not swallowed, because `report_run.status = 'failed'` with `error` set is what the status resource shows a waiting user.

**Files:**
- Create: `packages/db/src/reports/run-store.ts`, `packages/db/test/reports/run-store.test.ts`, `apps/worker/src/jobs/report-render.ts`, `apps/worker/test/reports/render.test.ts`
- Modify: `packages/db/src/reports/index.ts`, `packages/db/src/jobs/payloads.ts`, `apps/worker/src/index.ts`, `apps/worker/test/support/worker.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: `withTenant`, `systemContext`, `TenantContext` (§4.2.2); `JobHandler`, `registerHandler`, `JobEnvelope`, `JobPayload`, `runJob` (§4.2.6); `log` from `apps/worker/src/log.ts` (0D); `DatasetRow`, `ReportError` (Tasks 5–7); **`rowsForDefinition` (Task 9)** — the one row provider; this handler never calls `datasetFor` itself; `statementDefinition`, `STATEMENT_CODES` (Task 9, in the test only); `parseReportDefinition`, `renderReport`, `ReportDefinition` (Tasks 4, 8); `rendererFor`, `REPORT_EXTENSION` (Task 10); `i18nFormatters` (Task 10); `objectStore`, `setObjectStore` (Task 10); `startWorker`, `StartedWorker` (§4.17.1, 0D); `JobIsolationProbe`, `JOB_PROBES` (§4.2.6); `seedReportDefinition` (Task 1), `seedTenantV2`, `seedAccount`, `grantCodes` (§4.17); `postJournal` (§4.17.1).
- Produces:

```ts
// packages/db/src/reports/run-store.ts
export type ReportRunStatus = "queued" | "running" | "done" | "failed";
export interface ReportRunRow {
  id: string; companyId: string; reportDefinitionId: string; savedViewId: string | null;
  parameters: Readonly<Record<string, string>>; format: "pdf" | "xlsx" | "csv"; lang: "en" | "ar";
  status: ReportRunStatus; requestedBy: string; objectKey: string | null; sha256: string | null;
  finishedAt: string | null; error: string | null; createdAt: string;
}
/** '<tenant_id>/reports/<run_id>.<ext>' — server-generated from ids alone, so no client path can reach the
 *  store (LEGACY-038, the same rule §4.5.8's `objectKeyFor` follows for attachments). */
export function reportObjectKeyFor(tenantId: string, runId: string, extension: string): string;
export interface NewReportRun {
  companyId: string; reportDefinitionId: string; savedViewId?: string | null;
  parameters: Readonly<Record<string, string>>; format: "pdf" | "xlsx" | "csv"; lang: "en" | "ar";
}
export async function createReportRun(tx: Sql, input: NewReportRun): Promise<ReportRunRow>;
export async function getReportRun(tx: Sql, runId: string): Promise<ReportRunRow | null>;
export interface ReportRunQueryParams {
  companyId: string; filters: readonly FilterClauseLike[]; limit: number;
  cursor?: { createdAt: string; id: string } | null;
}
export interface FilterClauseLike { field: string; op: string; value: string }
export async function listReportRuns(tx: Sql, params: ReportRunQueryParams): Promise<ReportRunRow[]>;
/** Conditional: returns null when the run is not `queued` (a pg-boss re-delivery, or a cancelled run). */
export async function claimReportRun(tx: Sql, runId: string): Promise<ReportRunRow | null>;
export async function completeReportRun(tx: Sql, input: { runId: string; objectKey: string; sha256: Uint8Array }): Promise<void>;
export async function failReportRun(tx: Sql, input: { runId: string; error: string }): Promise<void>;
/** The run plus the stored definition JSON, in one read — the handler's first transaction. */
export async function loadRunDefinition(
  tx: Sql, runId: string,
): Promise<{ run: ReportRunRow; definition: unknown; baseCurrency: string } | null>;

// packages/db/src/jobs/payloads.ts — ONE key added; no other line changes (§4.2.6)
//   /** Slice 7A. The run row carries the definition, parameters, format and language. */
//   "reporting.render": { runId: string };

// apps/worker/src/jobs/report-render.ts
export const reportRender: JobHandler<"reporting.render">;
```

- [ ] **Step 1: Write the failing tests**

`packages/db/test/reports/run-store.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  claimReportRun, completeReportRun, createReportRun, failReportRun, getReportRun,
  listReportRuns, loadRunDefinition, reportObjectKeyFor,
} from "../../src/reports/run-store";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DEF = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read", parameters: [],
  dataset: { source: "account_balance", filters: [] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("the report_run store", () => {
  let db: Db;
  let s: Seed;
  let definitionId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "run-store");
    definitionId = await seedReportDefinition(db, s, { code: "accounting.trial_balance", definition: DEF });
  });
  afterAll(async () => { await db.stop(); });

  const asHuman = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[3]>[0]) => Promise<T>) =>
    withTenant(db.rw, s.tenant, s.human, fn);

  it("derives the object key from ids alone (LEGACY-038)", () => {
    expect(reportObjectKeyFor("01927f3a-0000-7000-8000-000000000001", "01927f3a-0000-7000-8000-0000000000aa", "pdf"))
      .toBe("01927f3a-0000-7000-8000-000000000001/reports/01927f3a-0000-7000-8000-0000000000aa.pdf");
  });

  it("creates a queued run, stamps requested_by, and reads it back", async () => {
    const run = await asHuman((tx) => createReportRun(tx, {
      companyId: s.company, reportDefinitionId: definitionId,
      parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en",
    }));
    expect(run.status).toBe("queued");
    expect(run.requestedBy).toBe(s.human);
    expect(run.parameters).toEqual({ fiscalPeriodId: s.period });
    expect(await asHuman((tx) => getReportRun(tx, run.id))).toEqual(run);
    expect(await asHuman((tx) => getReportRun(tx, definitionId))).toBeNull();
  });

  it("loadRunDefinition returns the run and the stored definition JSON in one read", async () => {
    const run = await asHuman((tx) => createReportRun(tx, {
      companyId: s.company, reportDefinitionId: definitionId, parameters: {}, format: "csv", lang: "ar",
    }));
    const loaded = await asHuman((tx) => loadRunDefinition(tx, run.id));
    expect(loaded!.run.id).toBe(run.id);
    expect(loaded!.definition).toEqual(DEF);
    // The company join, asserted: without it the render handler formats every money cell as `XXX 1,234.50`.
    expect(loaded!.baseCurrency).toBe("MYR");
  });

  it("claim moves queued → running exactly once — a pg-boss re-delivery gets null", async () => {
    const run = await asHuman((tx) => createReportRun(tx, {
      companyId: s.company, reportDefinitionId: definitionId, parameters: {}, format: "csv", lang: "en",
    }));
    expect((await asHuman((tx) => claimReportRun(tx, run.id)))!.status).toBe("running");
    expect(await asHuman((tx) => claimReportRun(tx, run.id))).toBeNull();
  });

  it("complete records the artefact; the CHECK refuses a done run without one", async () => {
    const run = await asHuman((tx) => createReportRun(tx, {
      companyId: s.company, reportDefinitionId: definitionId, parameters: {}, format: "pdf", lang: "en",
    }));
    await asHuman((tx) => claimReportRun(tx, run.id));
    const sha = new Uint8Array(createHash("sha256").update("x").digest());
    await asHuman((tx) => completeReportRun(tx, {
      runId: run.id, objectKey: reportObjectKeyFor(s.tenant, run.id, "pdf"), sha256: sha,
    }));
    const done = await asHuman((tx) => getReportRun(tx, run.id));
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(`${s.tenant}/reports/${run.id}.pdf`);
    expect(done!.sha256).toBe(Buffer.from(sha).toString("hex"));
    expect(done!.finishedAt).not.toBeNull();

    await asHuman(async (tx) => {
      await expect(
        tx`update app.report_run set status = 'done', object_key = null, sha256 = null where id = ${run.id}`,
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("fail records the reason; the CHECK refuses a failed run without one", async () => {
    const run = await asHuman((tx) => createReportRun(tx, {
      companyId: s.company, reportDefinitionId: definitionId, parameters: {}, format: "csv", lang: "en",
    }));
    await asHuman((tx) => failReportRun(tx, { runId: run.id, error: "ERR_REPORT_DATASET_UNKNOWN: dataset 'x' …" }));
    const failed = await asHuman((tx) => getReportRun(tx, run.id));
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toContain("ERR_REPORT_DATASET_UNKNOWN");
  });

  it("lists newest first, keyset-paged, and filters on status and format", async () => {
    const all = await asHuman((tx) => listReportRuns(tx, { companyId: s.company, filters: [], limit: 100 }));
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(all[0]!.createdAt >= all[1]!.createdAt).toBe(true);

    const page = await asHuman((tx) => listReportRuns(tx, { companyId: s.company, filters: [], limit: 2 }));
    const next = await asHuman((tx) => listReportRuns(tx, {
      companyId: s.company, filters: [], limit: 2,
      cursor: { createdAt: page[1]!.createdAt, id: page[1]!.id },
    }));
    expect(next.map((r) => r.id)).not.toContain(page[0]!.id);

    const failed = await asHuman((tx) => listReportRuns(tx, {
      companyId: s.company, filters: [{ field: "status", op: "eq", value: "failed" }], limit: 100,
    }));
    expect(failed.every((r) => r.status === "failed")).toBe(true);

    await expect(asHuman((tx) => listReportRuns(tx, {
      companyId: s.company, filters: [{ field: "object_key", op: "like", value: "x" }], limit: 10,
    }))).rejects.toThrowError(/filter field 'object_key' is not filterable on report runs/);
  });
});
```

`apps/worker/test/reports/render.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "@dulja/db";
import { createReportRun, getReportRun, reportObjectKeyFor } from "@dulja/db";
import { seedAccount, seedReportDefinition, seedTenantV2, grantCodes, type Seed } from "@dulja/db/test";
import { withTenant } from "@dulja/db";
import { statementDefinition } from "@dulja/domain";
import { setObjectStore } from "../../src/object-store";
import { startWorker, type StartedWorker } from "../support/worker";

const DEF = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: { source: "account_balance", filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }] },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
    { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
  ],
  groups: [], totals: [{ field: "base_debit", fn: "sum" }], sort: [{ field: "account_code", dir: "asc" }],
  layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "{rowCount}" },
  tieOut: { kind: "ledger_sum" },
};

describe("the reporting.render job", () => {
  let w: StartedWorker;
  let store: MemoryObjectStore;
  let s: Seed;
  let definitionId: string;

  beforeAll(async () => {
    store = new MemoryObjectStore();
    setObjectStore(store);
    w = await startWorker();
    s = await seedTenantV2(w.db, "render-job");
    await grantCodes(w.db, s, { codes: ["accounting.journal.post", "accounting.journal.create"] });
    const cash = await seedAccount(w.db, s, { code: "1000", nameEn: "Cash", type: "asset" });
    const sales = await seedAccount(w.db, s, { code: "4000", nameEn: "Sales", type: "income" });
    const { postJournal } = await import("../../../../tests/invariants/support/post-journal");
    // `JournalLine` names the field `account`, not `accountId` (§4.17.1, 1B).
    await postJournal(w.db, s, [{ account: cash, debit: "42.0000" }, { account: sales, credit: "42.0000" }]);
    definitionId = await seedReportDefinition(w.db, s, { code: "accounting.trial_balance", definition: DEF });
  });
  afterAll(async () => { await w.stop(); });

  const queue = (format: "csv" | "xlsx" | "pdf", lang: "en" | "ar" = "en") =>
    withTenant(w.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() }, (tx) =>
      createReportRun(tx, {
        companyId: s.company, reportDefinitionId: definitionId,
        parameters: { fiscalPeriodId: s.period }, format, lang,
      }));

  const read = (runId: string) =>
    withTenant(w.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() }, (tx) =>
      getReportRun(tx, runId));

  it("drives a run queued → done and stores the CSV under the derived key", async () => {
    const run = await queue("csv");
    await w.run("reporting.render", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } });
    const done = await read(run.id);
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(reportObjectKeyFor(s.tenant, run.id, "csv"));
    const stored = store.objects.get(done!.objectKey!)!;
    expect(stored.contentType).toBe("text/csv; charset=utf-8");
    const text = new TextDecoder().decode(stored.bytes);
    expect(text).toContain("1000,42.0000");
    expect(text).toContain("Total,42.0000");
  });

  it("records the sha256 of the stored bytes, so a download can be verified", async () => {
    const run = await queue("csv");
    await w.run("reporting.render", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } });
    const done = await read(run.id);
    const { createHash } = await import("node:crypto");
    const stored = store.objects.get(done!.objectKey!)!;
    expect(done!.sha256).toBe(createHash("sha256").update(stored.bytes).digest("hex"));
  });

  it("renders in Arabic with the Arabic labels", async () => {
    const run = await queue("csv", "ar");
    await w.run("reporting.render", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } });
    const done = await read(run.id);
    const text = new TextDecoder().decode(store.objects.get(done!.objectKey!)!.bytes);
    expect(text).toContain("الرمز");
    expect(text).toContain("مدين");
  });

  it("a re-delivery is harmless: the second run of the same job stores nothing new", async () => {
    const run = await queue("csv");
    const envelope = { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } };
    await w.run("reporting.render", envelope);
    const before = store.objects.size;
    await w.run("reporting.render", envelope);
    expect(store.objects.size).toBe(before);
    expect((await read(run.id))!.status).toBe("done");
  });

  it("a bad definition fails the RUN, not the job, and the reason reaches the status resource", async () => {
    const broken = await seedReportDefinition(w.db, s, {
      code: "accounting.general_ledger",
      definition: { ...DEF, code: "accounting.general_ledger", dataset: { source: "invoices", filters: [] } },
    });
    const run = await withTenant(
      w.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() },
      (tx) => createReportRun(tx, {
        companyId: s.company, reportDefinitionId: broken, parameters: {}, format: "csv", lang: "en",
      }));
    await w.run("reporting.render", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } });
    const failed = await read(run.id);
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toContain("ERR_REPORT_DATASET_UNKNOWN");
    expect(failed!.objectKey).toBeNull();
  });

  it("runs as the tenant's SYSTEM principal, and every write is audited under it (hazard 20)", async () => {
    const run = await queue("csv");
    await w.run("reporting.render", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } });
    const rows = await w.db.migrator<{ actor_id: string; action: string }[]>`
      select actor_id, action from app.audit_log
       where table_name = 'report_run' and row_id = ${run.id} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]);
    expect(rows[1]!.actor_id).toBe(s.system);      // the status moves are the system principal's
    expect(rows[2]!.actor_id).toBe(s.system);
  });

  it("renders a STATEMENT definition through statementRows, not through a plain dataset read", async () => {
    // The one end-to-end proof that `STATEMENT_CODES` is wired into the run path: this definition groups and
    // sorts on `section`, which `account_balance` does NOT declare as a column — so a handler that called
    // `datasetFor(source).run` directly would render an empty Section column with a total that still added up.
    const statement = statementDefinition("balance_sheet", {
      code: "accounting.balance_sheet", nameEn: "Balance sheet", nameAr: "الميزانية العمومية",
      permission: "accounting.report.read",
    });
    const definition = await seedReportDefinition(w.db, s, {
      code: "accounting.balance_sheet", definition: statement,
    });
    const run = await withTenant(
      w.db.rw, { tenantId: s.tenant, actorId: s.human, requestId: crypto.randomUUID() },
      (tx) => createReportRun(tx, {
        companyId: s.company, reportDefinitionId: definition,
        parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en",
      }));
    await w.run("reporting.render", { tenantId: s.tenant, requestId: crypto.randomUUID(), payload: { runId: run.id } });

    const done = await read(run.id);
    expect(done!.status).toBe("done");
    expect(done!.error).toBeNull();
    const csv = new TextDecoder().decode((await store.get(done!.objectKey!))!.bytes);
    expect(csv).toContain("Section");        // the header
    expect(csv).toContain("asset");          // the annotated value — the whole point of the dispatch
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/db test -- reports/run-store`
Expected: FAIL — `Failed to resolve import "../../src/reports/run-store"`.

- [ ] **Step 3: Write the run store**

`packages/db/src/reports/run-store.ts`:

```ts
import type { Sql } from "postgres";
import { ReportError } from "./errors";

export type ReportRunStatus = "queued" | "running" | "done" | "failed";

export interface ReportRunRow {
  id: string;
  companyId: string;
  reportDefinitionId: string;
  savedViewId: string | null;
  parameters: Readonly<Record<string, string>>;
  format: "pdf" | "xlsx" | "csv";
  lang: "en" | "ar";
  status: ReportRunStatus;
  requestedBy: string;
  objectKey: string | null;
  sha256: string | null;          // lower-case hex, so a caller can compare a download without a Buffer
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
}

/** Server-generated from ids alone — a client path can never reach the store (LEGACY-038, §4.5.8's rule). */
export function reportObjectKeyFor(tenantId: string, runId: string, extension: string): string {
  return `${tenantId}/reports/${runId}.${extension}`;
}

/** The SELECT list every read below shares, so one column list cannot drift from another. */
function selectList(tx: Sql) {
  return tx`r.id, r.company_id, r.report_definition_id, r.saved_view_id, r.parameters,
            r.format, r.lang, r.status, r.requested_by, r.object_key,
            encode(r.sha256, 'hex') as sha256,
            to_char(r.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as finished_at,
            r.error,
            to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;
}

interface RawRun {
  id: string; company_id: string; report_definition_id: string; saved_view_id: string | null;
  parameters: Record<string, string>; format: "pdf" | "xlsx" | "csv"; lang: "en" | "ar";
  status: ReportRunStatus; requested_by: string; object_key: string | null; sha256: string | null;
  finished_at: string | null; error: string | null; created_at: string;
}

function toRow(raw: RawRun): ReportRunRow {
  return {
    id: raw.id, companyId: raw.company_id, reportDefinitionId: raw.report_definition_id,
    savedViewId: raw.saved_view_id, parameters: raw.parameters, format: raw.format, lang: raw.lang,
    status: raw.status, requestedBy: raw.requested_by, objectKey: raw.object_key, sha256: raw.sha256,
    finishedAt: raw.finished_at, error: raw.error, createdAt: raw.created_at,
  };
}

export interface NewReportRun {
  companyId: string;
  reportDefinitionId: string;
  savedViewId?: string | null;
  parameters: Readonly<Record<string, string>>;
  format: "pdf" | "xlsx" | "csv";
  lang: "en" | "ar";
}

export async function createReportRun(tx: Sql, input: NewReportRun): Promise<ReportRunRow> {
  const [raw] = await tx<RawRun[]>`
    insert into app.report_run
      (tenant_id, company_id, report_definition_id, saved_view_id, parameters, format, lang, status)
    values (app.current_tenant(), ${input.companyId}, ${input.reportDefinitionId},
            ${input.savedViewId ?? null}, ${JSON.stringify(input.parameters)}::jsonb,
            ${input.format}, ${input.lang}, 'queued')
    returning ${selectList(tx)}`;
  return toRow(raw!);
}

export async function getReportRun(tx: Sql, runId: string): Promise<ReportRunRow | null> {
  const [raw] = await tx<RawRun[]>`select ${selectList(tx)} from app.report_run r where r.id = ${runId}`;
  return raw === undefined ? null : toRow(raw);
}

/**
 * The run, its definition and the company's base currency, in one read.
 *
 * `baseCurrency` is read here rather than sniffed from the rows because most datasets carry no `currency`
 * column at all - `item_profitability`, `stock_valuation` and every `base_*` amount are already in the
 * company's base currency by construction (contracts 4.3.3). Without it `Intl.NumberFormat` is handed the
 * empty string and renders every money cell as `XXX 1,234.50`, which is a WRONG report rather than a
 * failing one, so the value comes back from the transaction that is already open.
 */
export async function loadRunDefinition(
  tx: Sql, runId: string,
): Promise<{ run: ReportRunRow; definition: unknown; baseCurrency: string } | null> {
  const [raw] = await tx<(RawRun & { definition: unknown; base_currency: string })[]>`
    select ${selectList(tx)}, d.definition, c.base_currency
      from app.report_run r
      join app.report_definition d on d.id = r.report_definition_id
      join app.company           c on c.id = r.company_id
     where r.id = ${runId}`;
  return raw === undefined
    ? null
    : { run: toRow(raw), definition: raw.definition, baseCurrency: raw.base_currency };
}

/**
 * `queued → running`, conditionally. pg-boss retries three times by default (§4.2.6), and a second delivery
 * of a job whose first delivery finished must be a no-op rather than a second render: the `where status =
 * 'queued'` is what makes that true without a lock or a flag.
 */
export async function claimReportRun(tx: Sql, runId: string): Promise<ReportRunRow | null> {
  const [raw] = await tx<RawRun[]>`
    update app.report_run r set status = 'running'
     where r.id = ${runId} and r.status = 'queued'
    returning ${selectList(tx)}`;
  return raw === undefined ? null : toRow(raw);
}

export async function completeReportRun(
  tx: Sql, input: { runId: string; objectKey: string; sha256: Uint8Array },
): Promise<void> {
  await tx`
    update app.report_run
       set status = 'done', object_key = ${input.objectKey},
           sha256 = ${Buffer.from(input.sha256)}, finished_at = now(), error = null
     where id = ${input.runId}`;
}

export async function failReportRun(tx: Sql, input: { runId: string; error: string }): Promise<void> {
  await tx`
    update app.report_run
       set status = 'failed', error = ${input.error.slice(0, 2000)}, finished_at = now()
     where id = ${input.runId}`;
}

/** The four fields a caller may filter a run list on. `object_key` and `sha256` are deliberately absent: a
 *  filter over them is a probe of another principal's artefact by another name. */
const RUN_FILTER_FIELDS = ["status", "format", "lang", "report_definition_id"] as const;

export interface FilterClauseLike { field: string; op: string; value: string }

export interface ReportRunQueryParams {
  companyId: string;
  filters: readonly FilterClauseLike[];
  limit: number;
  cursor?: { createdAt: string; id: string } | null;
}

export async function listReportRuns(tx: Sql, params: ReportRunQueryParams): Promise<ReportRunRow[]> {
  let clause = tx``;
  for (const f of params.filters) {
    if (!(RUN_FILTER_FIELDS as readonly string[]).includes(f.field)) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `filter field '${f.field}' is not filterable on report runs; the fields are ${RUN_FILTER_FIELDS.join(", ")}`,
      );
    }
    if (f.op !== "eq") {
      throw new ReportError("ERR_VALIDATION_FAILED", `filter field '${f.field}' supports only the 'eq' operator`);
    }
    // Each branch is a literal fragment; the field never reaches SQL as text (test 27).
    const predicate =
      f.field === "status" ? tx`r.status = ${f.value}`
      : f.field === "format" ? tx`r.format = ${f.value}`
      : f.field === "lang" ? tx`r.lang = ${f.value}`
      : tx`r.report_definition_id = ${f.value}::uuid`;
    clause = tx`${clause} and ${predicate}`;
  }
  const keyset = params.cursor == null
    ? tx``
    : tx`and (r.created_at, r.id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`;
  const raws = await tx<RawRun[]>`
    select ${selectList(tx)}
      from app.report_run r
     where r.company_id = ${params.companyId}::uuid ${clause} ${keyset}
     order by r.created_at desc, r.id desc
     limit ${Math.min(Math.max(params.limit, 1), 1000)}`;
  return raws.map(toRow);
}
```

Add to `packages/db/src/reports/index.ts`:

```ts
export {
  claimReportRun, completeReportRun, createReportRun, failReportRun, getReportRun, listReportRuns,
  loadRunDefinition, reportObjectKeyFor,
  type FilterClauseLike, type NewReportRun, type ReportRunQueryParams, type ReportRunRow, type ReportRunStatus,
} from "./run-store";
```

- [ ] **Step 4: Add the payload key**

In `packages/db/src/jobs/payloads.ts`, add **one** key to the `JobPayload` interface. `JobPayload extends Record<JobName, unknown>`, so every other name keeps its type and no other line changes (§4.2.6):

```ts
  /** Slice 7A. The `report_run` row carries the definition, the parameters, the format and the language, so
   *  the payload is the run id and nothing else — a payload that repeated them could disagree with the row. */
  "reporting.render": { runId: string };
```

- [ ] **Step 5: Write the handler**

`apps/worker/src/jobs/report-render.ts`:

```ts
import { createHash } from "node:crypto";
import {
  claimReportRun, completeReportRun, failReportRun, loadRunDefinition, reportObjectKeyFor,
  rowsForDefinition, withTenant, type DatasetRow,
} from "@dulja/db";
import { parseReportDefinition, renderReport } from "@dulja/domain";
import type { JobHandler } from "../handler";
import { log } from "../log";
import { objectStore } from "../object-store";
import { i18nFormatters } from "../reports/formatters";
import { REPORT_EXTENSION, rendererFor } from "../reports/renderers";

/**
 * Five short transactions, never one long one (hazard 20, spec:1368): a render shells out to a PDF engine and
 * must not hold a transaction open across a child process. `ctx` is the tenant's SYSTEM principal —
 * `runJob` built it with `systemContext` — so every status move is audited under the system principal.
 */
export const reportRender: JobHandler<"reporting.render"> = async (sql, job, ctx) => {
  const { runId } = job.payload;
  const logger = log().child({ job: "reporting.render", run_id: runId, tenant_id: job.tenantId });

  // 1. claim. A pg-boss re-delivery of a finished job finds no queued row and returns — the whole
  //    idempotency story, with no flag and no advisory lock.
  const claimed = await withTenant(sql, ctx, (tx) => claimReportRun(tx, runId));
  if (claimed === null) {
    logger.info({}, "report run is not queued; nothing to do");
    return;
  }

  try {
    // 2. load the definition. Stored definitions were validated when written, so this is a schema parse:
    //    membership is not re-checked, because the registry may legitimately have grown (§4.16.2).
    const loaded = await withTenant(sql, ctx, (tx) => loadRunDefinition(tx, runId));
    if (loaded === null) throw new Error(`report run ${runId} vanished between claim and load`);
    const definition = parseReportDefinition(loaded.definition);
    const parameters = loaded.run.parameters;

    // 3. read the rows through `rowsForDefinition` (Task 9) — the ONE row provider. It dispatches a
    //    `STATEMENT_CODES` key to `statementRows` (which annotates `section` and serves the per-BRANCH cut
    //    from `ledger_entry`) and every other code to `datasetFor(source).run`, dropping a filter whose
    //    optional parameter was not supplied so an absent branch means "every branch" and not "no rows".
    //    The handler never calls `datasetFor` itself; a second dispatch here is how the two paths drift.
    const rows: DatasetRow[] = await withTenant(sql, ctx, (tx) =>
      rowsForDefinition(tx, definition, {
        companyId: loaded.run.companyId,
        parameters,
        limit: 100_000,
      }));

    // 4. render — pure, outside any transaction
    const rendered = renderReport(definition, rows, {
      format: loaded.run.format,
      lang: loaded.run.lang,
      // The company's base currency, never a sniff of the rows: a dataset with no `currency` column
      // would otherwise render every amount as `XXX 1,234.50` (see loadRunDefinition).
      formatters: i18nFormatters(loaded.run.lang, { currency: loaded.baseCurrency }),
      parameters,
    });
    const artefact = await rendererFor(loaded.run.format).render(rendered);

    // 5. store, then record. The object goes first: a run marked `done` whose object is missing would be a
    //    lie the CHECK cannot catch, whereas an orphan object is harmless and re-writable.
    const objectKey = reportObjectKeyFor(job.tenantId, runId, REPORT_EXTENSION[loaded.run.format]);
    await objectStore().put(objectKey, artefact.bytes, artefact.contentType);
    const sha256 = new Uint8Array(createHash("sha256").update(artefact.bytes).digest());
    await withTenant(sql, ctx, (tx) => completeReportRun(tx, { runId, objectKey, sha256 }));
    logger.info({ rows: rendered.rowCount, bytes: artefact.bytes.byteLength }, "report rendered");
  } catch (e) {
    // The RUN fails, not the job: a waiting user needs the reason on the status resource, and a thrown error
    // would only be retried three times and then lost. The message carries the code so the API can echo it.
    const detail = e instanceof Error
      ? `${(e as { code?: string }).code ?? "ERR_INTERNAL"}: ${e.message}`
      : `ERR_INTERNAL: ${String(e)}`;
    await withTenant(sql, ctx, (tx) => failReportRun(tx, { runId, error: detail }));
    logger.error({ detail }, "report render failed");
  }
};
```

Register it in `apps/worker/src/index.ts` beside 0D's two and every later slice's:

```ts
registerHandler("reporting.render", reportRender);
```

and in `apps/worker/test/support/worker.ts`'s `startWorker()`, add the same line so `w.run("reporting.render", …)` resolves.

- [ ] **Step 6: Add the job isolation probe**

In `tests/invariants/probes.ts`, add the `JOB_PROBES` entry §3.7.2 requires — the harness enqueues the job for tenant A with tenant B's ids and asserts zero rows touched:

```ts
  "reporting.render": {
    async seed(db, attacker, victim) {
      // The victim owns a definition and a queued run; the attacker's tenant knows the run's id.
      const definitionId = await seedReportDefinition(db, victim, {
        code: "accounting.trial_balance", definition: VICTIM_DEFINITION,
      });
      await withTenant(db.rw, victim.tenant, victim.human, async (tx) => {
        await tx`insert into app.report_run
                   (tenant_id, company_id, report_definition_id, parameters, format, lang, status)
                 values (${victim.tenant}, ${victim.company}, ${definitionId}, '{}'::jsonb, 'csv', 'en', 'queued')`;
      });
      // The attacker also needs one definition, or its own render would fail for the wrong reason.
      await seedReportDefinition(db, attacker, { code: "accounting.ledger", definition: ATTACKER_DEFINITION });
    },
    async survivors(db, victim) {
      // Still queued: `claimReportRun` ran under the attacker's tenant, where RLS makes the row invisible.
      const [row] = await withTenant(db.rw, victim.tenant, victim.human, (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from app.report_run where status = 'queued'`);
      return row!.n;
    },
  },
```

- [ ] **Step 7: Run everything to see it pass**

Run: `bun run --cwd packages/db test -- reports/run-store && bun run --cwd apps/worker test -- reports/render && bun run --cwd tests test -- job-isolation`
Expected: PASS. The isolation probe's `survivors` returns 1 — the victim's run is still `queued`, because the handler ran under the attacker's tenant and RLS hid the row, so `claimReportRun` returned `null` and the handler logged "nothing to do".

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/reports/run-store.ts packages/db/src/reports/index.ts \
        packages/db/src/jobs/payloads.ts packages/db/test/reports/run-store.test.ts \
        apps/worker/src/jobs/report-render.ts apps/worker/src/index.ts \
        apps/worker/test/support/worker.ts apps/worker/test/reports/render.test.ts \
        tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(worker): add the reporting.render job and the report_run lifecycle [7A T11]

Five short transactions as the tenant's system principal (hazard 20). The
queued → running move is a conditional update, so a pg-boss re-delivery is a
no-op with no flag and no lock. The object is stored before the row is marked
done, because an orphan object is harmless and a done run with no artefact is a
lie. A bad definition fails the RUN with its code on the status resource, never
the job. JobPayload gains one key; JOB_PROBES gains one entry.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: `POST …/reports/{code}/runs`, the run resource, and the two data-resolved permission gates

§4.11.2 fixes the route: `POST /v1/companies/{companyId}/reports/{code}/runs` → `202`. §4.2.7 fixes where it goes: **7A extends 1B's `reportsRouteModule` and must not create a second module on `/v1/companies/:companyId/reports`**, because `PROBES` is keyed by `RouteModule.path` (hazard 31). The run resource itself is a new module.

**Why both permission checks are inline rather than `requirePermission` middleware — three independent reasons.**

1. **A definition's `permission` is a data value.** `requirePermission(code, scope)` takes a compile-time `PermissionCode`; the code that gates `pos.z_report` lives in a jsonb column. This is exactly 2B's overrides-gate situation (§4.5.3), resolved the same way: an inline `app.actor_has(code, company)` pre-flight inside `c.var.withTenant`, with the data layer still the control.
2. **`PERMISSION["pos.report.read"]` does not compile at 7A.** `PermissionCode` is derived from `PERMISSIONS`, and 6D seeds `pos.report.read`. §4.5.8 states this rule for `hr.payroll.read` and it binds identically here: a compile-time reference to a code whose slice has not landed is a build error, and `permission-catalogue` would fail on it anyway.
3. **`auditor` must be able to export, and holds no mutating code (R7).** `accounting.report.export` is `mutating: false`, and `assertRouteGates` (§4.2.5) throws `ERR_ROUTE_GATE_READONLY` at boot when an **unsafe** method is gated by a non-mutating code. So a `POST` **cannot** carry it as middleware, by design — the boot check is what forces the inline form, and that is the right answer: spec:2163 gives the auditor export authority and spec:2147 makes it non-mutating.

**Files:**
- Create: `apps/api/src/routes/accounting/report-runs.ts`, `packages/contracts/src/accounting/report-run.ts`, `apps/api/test/routes/accounting/report-runs.test.ts`
- Modify: `apps/api/src/reports/authorise.ts` (**created by Task 3 with `requireReportExport`; this task appends three functions below it and edits none**), `apps/api/src/routes/accounting/reports.ts`, `apps/api/src/routes/index.ts`, `packages/contracts/src/index.ts`, `apps/api/test/routes/accounting/reports.test.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: `requireReportExport` from `apps/api/src/reports/authorise.ts` (**Task 3**); `reportsRoutes`, `reportsRouteModule` from `apps/api/src/routes/accounting/reports.ts` (1B) — **extended, never replaced**; `RouteModule`, `buildRoutes`, `IdempotencyHeader` (§4.2.7); `AppEnv`, `RequestContext` (§4.2.3) — **including the eighth `Variables` member `jobs: JobClient` that 3B's amendment A5 added** (3b:39, set by the two-line middleware in `apps/api/src/app.ts` from `deps.jobs`; the `POST` below reads `c.var.jobs` and this slice adds no member of its own); `AppError`, `Problem`, `ProblemSchema` (§4.2.4); `PERMISSION`, `PermissionCode` (§4.2.5); `UuidSchema`, `TimestampSchema`, `ListEnvelope`, `ListQuery`, `CursorSchema`, `encodeCursor`, `decodeCursor`, `parseFilters`, `FILTER_OPS` (§4.2.8); `JobClient` (§4.2.6); `createReportRun`, `getReportRun`, `listReportRuns`, `loadRunDefinition`, `ReportRunRow` (Task 11); `parseReportDefinition` (Task 4); `objectStore` — no: `apps/api` uses its own `AppDeps.objectStore` (§4.2.7, 2C); `startApi`, `StartedApi`, `problemOf`, `grantAdmin` (§4.2.12, §4.17.1); `seedReportDefinition`, `grantCodes`, `seedTenantV2` (§4.17).
- Produces:

```ts
// packages/contracts/src/accounting/report-run.ts
export const ReportFormatSchema: z.ZodEnum<["pdf", "xlsx", "csv"]>;
export const ReportLangSchema: z.ZodEnum<["en", "ar"]>;
export const ReportRunStatusSchema: z.ZodEnum<["queued", "running", "done", "failed"]>;
export const ReportParametersSchema: z.ZodRecord<z.ZodString, z.ZodString>;
export const CreateReportRunBody: z.ZodObject<{
  reportDefinitionId: z.ZodOptional<z.ZodString>; savedViewId: z.ZodOptional<z.ZodString>;
  parameters: typeof ReportParametersSchema; format: typeof ReportFormatSchema; lang: typeof ReportLangSchema;
}>;
export const ReportRunAcceptedSchema: z.ZodObject<{ runId: z.ZodString; jobId: z.ZodString; statusUrl: z.ZodString }>;
export const ReportRunSchema: z.ZodObject<{ /* the ReportRunRow wire shape */ }>;
export const ReportRunQuery: z.ZodObject<{ /* ListQuery + filter[<field>][eq] keys */ }>;
export const ReportRunList: z.ZodObject<{ items: …; next_cursor: … }>;
export type ReportRunDto = z.infer<typeof ReportRunSchema>;

// apps/api/src/reports/authorise.ts — APPENDED to Task 3's file; `requireReportExport` is Task 3's and is
// consumed here unchanged.
/** The definition's own read code, resolved from data. Throws AppError ERR_RBAC_FORBIDDEN naming the code. */
export async function requireReportRead(c: Context<AppEnv>, companyId: string, permission: string): Promise<void>;
/** Resolves `{code}` to the highest non-archived version, or to `reportDefinitionId` when the body names one. */
export async function resolveDefinitionForRun(
  c: Context<AppEnv>, companyId: string, code: string, reportDefinitionId?: string,
): Promise<{ id: string; definition: ReportDefinition }>;

// apps/api/src/routes/accounting/report-runs.ts
/** A **factory**, like 0B's `createUserRoutes(authAdmin)` and 2C's `createAttachmentRoutes(objectStore)` —
 *  the download route needs the store, and §4.2.3's `Variables` set is closed to any slice that has not
 *  amended it (7A adds none; it only READS 3B's `jobs`), so the store arrives through the closure and never
 *  through the context (§4.2.7's "the reason `buildRoutes` takes deps"). */
export function createReportRunRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv>;
export const REPORT_RUN_ROUTE_PATH = "/v1/companies/:companyId/report-runs";
```

- [ ] **Step 1: Write the failing test**

`apps/api/test/routes/accounting/report-runs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { grantCodes, seedAccount, seedReportDefinition, seedTenantV2, type Seed } from "@dulja/db/test";
// Task 10 Step 8 widened `dependency-rule`'s test-tier allowance to `tests/support/**` and added the
// `apps/api/tsconfig.json` include this line needs; if Task 10 has not run, this import fails lint.
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const DEF = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: { source: "account_balance", filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("POST /v1/companies/{companyId}/reports/{code}/runs", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let definitionId: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "runs-api");
    other = await seedTenantV2(api.db, "runs-api-other");
    await grantCodes(api.db, s, {
      codes: ["accounting.report.read", "accounting.report.export", "accounting.journal.post", "accounting.journal.create"],
    });
    await seedAccount(api.db, s, { code: "1000", nameEn: "Cash", type: "asset" });
    definitionId = await seedReportDefinition(api.db, s, { code: "accounting.trial_balance", definition: DEF });
    await api.loadPrincipals();
  });
  afterAll(async () => { await api.stop(); });

  const post = (body: unknown, as = s.human, code = "accounting.trial_balance") =>
    api.request({ method: "POST", path: `/v1/companies/${s.company}/reports/${code}/runs`, body, as });

  it("returns 202 with the run id, the job id and the run's own status URL", async () => {
    const res = await post({ parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" });
    expect(res.status).toBe(202);
    const body = await res.json() as { runId: string; jobId: string; statusUrl: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.jobId.length).toBeGreaterThan(0);
    // ADR 0067: §4.11.2's literal "/v1/jobs/<jobId>" is replaced by the run resource, because NO slice mounts
    // /v1/jobs/{jobId} — §4.2.7 lists the path and assigns it to no module, and 6A dropped its own statusUrl
    // for the same reason. Pointing a caller at an unmounted path is a 404 dressed as a contract.
    expect(body.statusUrl).toBe(`/v1/companies/${s.company}/report-runs/${body.runId}`);
    const status = await api.request({ method: "GET", path: body.statusUrl, as: s.human });
    expect(status.status).toBe(200);
    expect((await status.json() as { status: string }).status).toBe("queued");
  });

  it("resolves {code} to the highest non-archived version, and accepts an explicit id", async () => {
    const v2 = await seedReportDefinition(api.db, s, {
      code: "accounting.trial_balance", definitionVersion: 2,
      definition: { ...DEF, nameEn: "Trial balance v2" }, isCore: true,
    });
    const res = await post({ parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" });
    const runId = (await res.json() as { runId: string }).runId;
    const run = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-runs/${runId}`, as: s.human });
    expect((await run.json() as { reportDefinitionId: string }).reportDefinitionId).toBe(v2);

    const pinned = await post({
      reportDefinitionId: definitionId, parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en",
    });
    const pinnedRunId = (await pinned.json() as { runId: string }).runId;
    const pinnedRun = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-runs/${pinnedRunId}`, as: s.human });
    expect((await pinnedRun.json() as { reportDefinitionId: string }).reportDefinitionId).toBe(definitionId);
  });

  it("404s an unknown code and an archived-only code, without revealing another tenant's rows", async () => {
    expect((await post({ parameters: {}, format: "csv", lang: "en" }, s.human, "accounting.general_ledger")).status).toBe(404);
    const foreign = await seedReportDefinition(api.db, other, { code: "accounting.ledger", definition: { ...DEF, code: "accounting.ledger" } });
    const res = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/reports/accounting.ledger/runs`,
      body: { reportDefinitionId: foreign, parameters: {}, format: "csv", lang: "en" }, as: s.human,
    });
    expect(res.status).toBe(404);
  });

  it("refuses a missing required parameter with ERR_VALIDATION_FAILED naming it", async () => {
    const problem = await problemOf(await post({ parameters: {}, format: "csv", lang: "en" }));
    expect(problem.status).toBe(400);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors).toEqual([{ path: "/parameters/fiscalPeriodId", message: "required parameter is missing" }]);
  });

  it("refuses a format or language outside the closed vocabularies", async () => {
    expect((await problemOf(await post({ parameters: { fiscalPeriodId: s.period }, format: "docx", lang: "en" }))).code)
      .toBe("ERR_VALIDATION_FAILED");
    expect((await problemOf(await post({ parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "fr" }))).code)
      .toBe("ERR_VALIDATION_FAILED");
  });

  it("requires BOTH the definition's read code and accounting.report.export", async () => {
    // No codes AND no definition: 403, not 404 — `requireReportExport` gates on the path parameter before
    // `resolveDefinitionForRun` reads a row (see the handler's gate-order comment), so the route is never an
    // existence oracle for a company's report catalogue and the `report-runs` isolation probe can expect 403.
    const bare = await seedTenantV2(api.db, "runs-api-bare");
    await api.loadPrincipals();
    const noCodes = await api.request({
      method: "POST", path: `/v1/companies/${bare.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: {}, format: "csv", lang: "en" }, as: bare.human,
    });
    expect(noCodes.status).toBe(403);

    const readOnly = await seedTenantV2(api.db, "runs-api-read");
    await grantCodes(api.db, readOnly, { codes: ["accounting.report.read"] });
    await seedReportDefinition(api.db, readOnly, { code: "accounting.trial_balance", definition: DEF });
    await api.loadPrincipals();
    const problem = await problemOf(await api.request({
      method: "POST", path: `/v1/companies/${readOnly.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: { fiscalPeriodId: readOnly.period }, format: "csv", lang: "en" }, as: readOnly.human,
    }));
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.report.export");
  });

  it("refuses a definition whose OWN read code the caller lacks, even with the export code (module read codes)", async () => {
    // The card's permission bullet ends "…, module read codes", and this is the case `requireReportRead`
    // exists for: the gate is the DEFINITION's `permission` value, resolved from data through `app.actor_has`,
    // not a compile-time code on the route. A caller holding `accounting.report.export` and
    // `accounting.report.read` still cannot render an inventory report gated `inventory.stock.read`.
    const crossModule = await seedTenantV2(api.db, "runs-api-cross-module");
    await grantCodes(api.db, crossModule, {
      codes: ["accounting.report.export", "accounting.report.read"], roleCode: "EXPORTER",
    });
    await seedReportDefinition(api.db, crossModule, {
      code: "inventory.stock_on_hand",
      definition: {
        ...DEF, code: "inventory.stock_on_hand", nameEn: "Stock on hand", nameAr: "المخزون المتاح",
        module: "inventory", permission: "inventory.stock.read",
        parameters: [], dataset: { source: "stock_on_hand", filters: [] },
        columns: [{ field: "item_code", labelEn: "Item", labelAr: "الصنف", format: "text", align: "start" }],
      },
    });
    await api.loadPrincipals();
    const problem = await problemOf(await api.request({
      method: "POST", path: `/v1/companies/${crossModule.company}/reports/inventory.stock_on_hand/runs`,
      body: { parameters: {}, format: "csv", lang: "en" }, as: crossModule.human,
    }));
    expect(problem.status).toBe(403);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("inventory.stock.read");
  });

  it("requires the Idempotency-Key header and replays the stored 202 on the same key", async () => {
    const missing = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" },
      as: s.human, idempotencyKey: null,
    });
    expect((await missing.json() as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" },
      as: s.human, idempotencyKey: key,
    });
    const replay = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" },
      as: s.human, idempotencyKey: key,
    });
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
  });
});

describe("the report-run resource", () => {
  let api: StartedApi;
  let s: Seed;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "run-res");
    await grantCodes(api.db, s, { codes: ["accounting.report.read", "accounting.report.export"] });
    await seedReportDefinition(api.db, s, { code: "accounting.trial_balance", definition: { ...DEF, parameters: [], dataset: { source: "account_balance", filters: [] } } });
    await api.loadPrincipals();
    for (const format of ["csv", "xlsx", "pdf"] as const) {
      await api.request({
        method: "POST", path: `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`,
        body: { parameters: {}, format, lang: "en" }, as: s.human,
      });
    }
  });
  afterAll(async () => { await api.stop(); });

  it("lists newest first with a cursor, and accepts the filter[<field>][eq] grammar", async () => {
    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-runs?limit=2`, as: s.human });
    const body = await res.json() as { items: { id: string; format: string }[]; next_cursor: string | null };
    expect(body.items).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();

    const filtered = await api.request({
      method: "GET", path: `/v1/companies/${s.company}/report-runs?filter[format][eq]=pdf`, as: s.human,
    });
    const only = await filtered.json() as { items: { format: string }[] };
    expect(only.items.every((r) => r.format === "pdf")).toBe(true);

    const bad = await problemOf(await api.request({
      method: "GET", path: `/v1/companies/${s.company}/report-runs?filter[object_key][eq]=x`, as: s.human,
    }));
    expect(bad.code).toBe("ERR_VALIDATION_FAILED");
  });

  it("404s the content of a run that is not done, and 200s the bytes once it is", async () => {
    const list = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-runs?limit=1`, as: s.human });
    const runId = (await list.json() as { items: { id: string }[] }).items[0]!.id;
    const early = await problemOf(await api.request({
      method: "GET", path: `/v1/companies/${s.company}/report-runs/${runId}/content`, as: s.human,
    }));
    expect(early.code).toBe("ERR_NOT_FOUND");
    expect(early.detail).toContain("has not finished");

    // Simulate the worker's completion: the API side of the contract is what this test covers.
    const key = `${s.tenant}/reports/${runId}.csv`;
    await api.objectStore.put(key, new TextEncoder().encode("Code\r\n1000\r\n"), "text/csv; charset=utf-8");
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update("Code\r\n1000\r\n").digest();
    await api.db.rw`select set_config('app.tenant_id', ${s.tenant}, false), set_config('app.actor_id', ${s.human}, false)`;
    await api.db.rw`update app.report_run set status = 'done', object_key = ${key}, sha256 = ${digest}, finished_at = now() where id = ${runId}`;

    const res = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-runs/${runId}/content`, as: s.human });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("accounting.trial_balance");
    expect(await res.text()).toBe("Code\r\n1000\r\n");
  });

  it("the content route needs accounting.report.export too — the download IS the export", async () => {
    const readOnly = await seedTenantV2(api.db, "run-res-read");
    await grantCodes(api.db, readOnly, { codes: ["accounting.report.read"] });
    await api.loadPrincipals();
    const res = await api.request({
      method: "GET", path: `/v1/companies/${readOnly.company}/report-runs/${crypto.randomUUID()}/content`, as: readOnly.human,
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd apps/api test -- routes/accounting/report-runs`
Expected: FAIL — the first `it` gets 404, because neither the runs sub-path nor the run module is mounted.

- [ ] **Step 3: Write the contracts module**

`packages/contracts/src/accounting/report-run.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";

export const ReportFormatSchema = z.enum(["pdf", "xlsx", "csv"]).openapi("ReportFormat");
export const ReportLangSchema = z.enum(["en", "ar"]).openapi("ReportLang");
export const ReportRunStatusSchema = z.enum(["queued", "running", "done", "failed"]).openapi("ReportRunStatus");

/** Every parameter value travels as a STRING: a date is `YYYY-MM-DD`, an id a uuid, an amount a decimal
 *  string. The dataset's per-column kind is what casts it (Task 5), so a JSON number can never become a
 *  monetary value on the way in (spec:2041). */
export const ReportParametersSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,47}$/), z.string().max(200))
  .openapi("ReportParameters");

export const CreateReportRunBody = z.object({
  /** Omit to use the highest non-archived version of `{code}`; pass it to pin a version or a tenant clone. */
  reportDefinitionId: UuidSchema.optional(),
  savedViewId: UuidSchema.optional(),
  parameters: ReportParametersSchema.default({}),
  format: ReportFormatSchema,
  lang: ReportLangSchema,
}).openapi("CreateReportRunBody");

export const ReportRunAcceptedSchema = z.object({
  runId: UuidSchema,
  jobId: z.string().min(1),
  /** The run resource — see ADR 0067. NOT `/v1/jobs/<jobId>`: no slice mounts that path. */
  statusUrl: z.string().min(1),
}).openapi("ReportRunAccepted");

export const ReportRunSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  reportDefinitionId: UuidSchema,
  savedViewId: UuidSchema.nullable(),
  parameters: ReportParametersSchema,
  format: ReportFormatSchema,
  lang: ReportLangSchema,
  status: ReportRunStatusSchema,
  requestedBy: UuidSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  finishedAt: TimestampSchema.nullable(),
  error: z.string().nullable(),
  createdAt: TimestampSchema,
  // `object_key` is deliberately NOT on the wire: it is a store path, and the download route is the only way
  // to reach the bytes (LEGACY-038 — attachment identity is a side channel, and a report artefact is the same).
}).openapi("ReportRun");

/**
 * Literal `filter[<field>][eq]` keys — §4.2.8 Layer 2's default mechanism. Four fields, one operator, so
 * enumerating them is typed, checked by Zod and visible in the generated OpenAPI document; `parseFilters`
 * stays the mechanism for a wide surface and is not used on this route.
 */
export const ReportRunQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  "filter[status][eq]": ReportRunStatusSchema.optional(),
  "filter[format][eq]": ReportFormatSchema.optional(),
  "filter[lang][eq]": ReportLangSchema.optional(),
  "filter[report_definition_id][eq]": UuidSchema.optional(),
}).openapi("ReportRunQuery");

export const ReportRunList = ListEnvelope(ReportRunSchema).openapi("ReportRunList");
export type ReportRunDto = z.infer<typeof ReportRunSchema>;
```

Re-export it from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Append the three remaining authorisation helpers**

`apps/api/src/reports/authorise.ts` — **Task 3 created this file with `requireReportExport`.** Append the three functions below *after* it and change nothing above them. Two imports are added to the existing import block (`parseReportDefinition` / `ReportDefinition`); `Context`, `AppError` and `AppEnv` are already there and `PERMISSION` stays for `requireReportExport`'s own use.

```ts
// added to the existing import block:
import { parseReportDefinition, type ReportDefinition } from "@dulja/domain";

/**
 * The definition's own read code, resolved from DATA. `requirePermission` takes a compile-time
 * `PermissionCode` and a definition's `permission` is a jsonb value, so this is 2B's overrides-gate shape
 * (§4.5.3): an inline `app.actor_has` pre-flight inside `c.var.withTenant`, with the data layer still the
 * control. It is also the only form that works before Phase 6 — `PERMISSION["pos.report.read"]` is a compile
 * error until 6D seeds the code (§4.5.8's rule for `hr.payroll.read`).
 */
export async function requireReportRead(c: Context<AppEnv>, companyId: string, permission: string): Promise<void> {
  const allowed = await c.var.withTenant(async (tx) => {
    const [row] = await tx<{ ok: boolean }[]>`select app.actor_has(${permission}, ${companyId}::uuid) as ok`;
    return row?.ok === true;
  });
  if (!allowed) {
    throw new AppError(
      "ERR_RBAC_FORBIDDEN",
      `this report requires the permission '${permission}', which the caller does not hold in this company`,
    );
  }
}

/**
 * `{code}` → the definition to run. With no `reportDefinitionId`, the highest non-archived `version` wins, so
 * a tenant's clone at `max(version) + 1` is what a plain run picks up (the DoD's "clones and edits without a
 * release") and 7B seeding `version = 2` of a core code promotes that version for everyone.
 */
export async function resolveDefinitionForRun(
  c: Context<AppEnv>,
  companyId: string,
  code: string,
  reportDefinitionId?: string,
): Promise<{ id: string; definition: ReportDefinition }> {
  const row = await c.var.withTenant(async (tx) => {
    if (reportDefinitionId !== undefined) {
      const [pinned] = await tx<{ id: string; definition: unknown }[]>`
        select id, definition from app.report_definition
         where id = ${reportDefinitionId}::uuid and company_id = ${companyId}::uuid
           and code = ${code} and archived_at is null`;
      return pinned;
    }
    const [latest] = await tx<{ id: string; definition: unknown }[]>`
      select id, definition from app.report_definition
       where company_id = ${companyId}::uuid and code = ${code} and archived_at is null
       order by version desc limit 1`;
    return latest;
  });
  if (row === undefined) {
    // Never reveals cross-tenant existence: RLS reduced the table before the predicate ran (§4.2.4).
    throw new AppError("ERR_NOT_FOUND", `no live report definition for code '${code}' in this company`);
  }
  return { id: row.id, definition: parseReportDefinition(row.definition) };
}

/** Every `required` parameter must be present and non-empty. The errors are JSON Pointers into the body,
 *  which is what §4.2.4 lets `ERR_VALIDATION_FAILED` carry. */
export function assertParameters(definition: ReportDefinition, parameters: Readonly<Record<string, string>>): void {
  const errors = definition.parameters
    .filter((p) => p.required && (parameters[p.name] === undefined || parameters[p.name] === ""))
    .map((p) => ({ path: `/parameters/${p.name}`, message: "required parameter is missing" }));
  const unknown = Object.keys(parameters)
    .filter((name) => !definition.parameters.some((p) => p.name === name))
    .map((name) => ({ path: `/parameters/${name}`, message: "this report declares no such parameter" }));
  const all = [...errors, ...unknown];
  if (all.length > 0) {
    throw new AppError("ERR_VALIDATION_FAILED", `the run parameters do not match the report's declaration`, { errors: all });
  }
}
```

- [ ] **Step 5: Add the runs sub-path to 1B's module**

In `apps/api/src/routes/accounting/reports.ts`, **append** to the existing `reportsRoutes` and extend `reportsRouteModule.permissions`. 1B's two `GET` routes and their handlers are not touched.

**First, the imports.** 1B's file mounts two `GET`s, so it carries none of the names this POST needs. Add each of these **only where it is missing** — adding an import is not editing an earlier route, and a duplicate import is a `lint` failure rather than a silent problem:

```ts
import { IdempotencyHeader } from "../index";
import {
  CreateReportRunBody, ReportRunAcceptedSchema,          // Step 3, packages/contracts
} from "@dulja/contracts";
import { createReportRun } from "@dulja/db";             // Task 11
// ALL FOUR helpers, because the handler below calls all four: `requireReportExport` and
// `resolveDefinitionForRun` are Task 3's and Step 4's, and `requireReportRead` and `assertParameters` are
// Step 4's too — an import list naming only the first two leaves the file uncompilable.
import {
  assertParameters, requireReportExport, requireReportRead, resolveDefinitionForRun,
} from "../../reports/authorise";                        // Task 3 + Step 4
```

`createRoute`, `z`, `AppError`, `ProblemSchema` and `UuidSchema` are already there — 1B's two `GET`s use all five. `JobClient` reaches the handler through `c.var`, so it is not an import here.

Then the route:

```ts
reportsRoutes.openapi(createRoute({
  method: "post",
  path: "/{code}/runs",
  tags: ["reports"],
  // No `middleware` — both gates are inline (see apps/api/src/reports/authorise.ts for the three reasons).
  request: {
    headers: IdempotencyHeader,
    params: z.object({ companyId: UuidSchema, code: z.string().regex(/^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/) }),
    body: { content: { "application/json": { schema: CreateReportRunBody } } },
  },
  responses: {
    202: { description: "The render is queued", content: { "application/json": { schema: ReportRunAcceptedSchema } } },
    400: { description: "Invalid", content: { "application/problem+json": { schema: ProblemSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "No such report", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
}), async (c) => {
  const { companyId, code } = c.req.valid("param");
  const body = c.req.valid("json");

  // GATE ORDER IS DELIBERATE. `requireReportExport` runs FIRST, on the path parameter alone, before any row
  // is read — so a caller with no codes at all is refused 403 whether or not a definition exists, and the
  // route never becomes an existence oracle for a company's report catalogue. `report-runs`' tenant-isolation
  // probe (Task 13 Step 8) expects 403 for exactly this reason, and the two GET handlers below gate the same
  // way. Only after the caller has proved export authority is the definition resolved (404 if there is none)
  // and its own read code evaluated.
  await requireReportExport(c, companyId);
  const { id, definition } = await resolveDefinitionForRun(c, companyId, code, body.reportDefinitionId);
  await requireReportRead(c, companyId, definition.permission);
  assertParameters(definition, body.parameters);

  // The run row and the pg-boss job are inserted in ONE transaction: the job goes through `tx`, so it is
  // visible only after the commit and never on a rollback (§4.2.6, spec:2321). A rolled-back request
  // therefore leaves neither a queued run nor a job that would fail looking for it.
  const { runId, jobId } = await c.var.withTenant(async (tx) => {
    const run = await createReportRun(tx, {
      companyId,
      reportDefinitionId: id,
      savedViewId: body.savedViewId ?? null,
      parameters: body.parameters,
      format: body.format,
      lang: body.lang,
    });
    const job = await c.var.jobs.enqueue(tx, "reporting.render", {     // 3B amendment A5's eighth Variable
      tenantId: c.var.ctx.tenantId, requestId: c.var.ctx.requestId, payload: { runId: run.id },
    });
    return { runId: run.id, jobId: job };
  });

  return c.json({ runId, jobId, statusUrl: `/v1/companies/${companyId}/report-runs/${runId}` }, 202);
});

export const reportsRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/reports",
  router: reportsRoutes,
  // 1B's two plus 7A's one. §3.6.3's lint reads this array, and `accounting.report.export` is evaluated by
  // `requireReportExport` rather than by middleware — the array records what the module evaluates, not how.
  permissions: [
    PERMISSION["accounting.report.read"],
    PERMISSION["accounting.ledger.read"],
    PERMISSION["accounting.report.export"],
  ],
  auth: "human",
};
```

**`AppDeps.jobs` reaches this handler through `c.var.jobs` — 3B's amendment A5, and 7A adds nothing of its own.** A5 (3b:39) gives `AppEnv["Variables"]` its eighth member `jobs: JobClient`, set by the two-line middleware `createApp` already runs in `apps/api/src/app.ts` from `deps.jobs` (3b:3260, 3b:185); 1A's post handler and 2B's reverse handler read it the same way (3b:3268–3270). The context is the only route open here: this `POST` is a **sub-path on 1B's existing `reportsRoutes` const**, not a factory, so there is no closure to pass a `JobClient` through. **Confirm A5 is in §4.2.3's head before starting this task** — the Execution-handoff amendments table marks it ⚑ BEFORE, and without it `c.var.jobs` does not type-check. Do **not** add a ninth member.

- [ ] **Step 6: Write the run-resource module**

`apps/api/src/routes/accounting/report-runs.ts`:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, ProblemSchema, ReportRunList, ReportRunQuery, ReportRunSchema, UuidSchema, decodeCursor, encodeCursor } from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { getReportRun, listReportRuns, loadRunDefinition, type ObjectStore, type ReportRunRow } from "@dulja/db";
import { parseReportDefinition } from "@dulja/domain";
import type { Context } from "hono";
import type { AppEnv } from "../../context";
import { requireReportExport, requireReportRead } from "../../reports/authorise";

export const REPORT_RUN_ROUTE_PATH = "/v1/companies/:companyId/report-runs";

/** A factory: the download route needs the `ObjectStore`, and §4.2.3's registered `Variables` set is closed —
 *  a slice adding a member amends that section first (3B's A5 did, for `jobs`), and 7A adds none. So the
 *  store arrives through this closure — never through the context, and never as a module
 *  singleton, which would make the route untestable against `startApi()`'s `MemoryObjectStore`. */
export function createReportRunRoutes(objectStore: ObjectStore): OpenAPIHono<AppEnv> {
const reportRunRoutes = new OpenAPIHono<AppEnv>();

/** `object_key` never reaches the wire; the download route is the only path to the bytes (LEGACY-038). */
function toDto(run: ReportRunRow) {
  return {
    id: run.id, companyId: run.companyId, reportDefinitionId: run.reportDefinitionId,
    savedViewId: run.savedViewId, parameters: run.parameters, format: run.format, lang: run.lang,
    status: run.status, requestedBy: run.requestedBy, sha256: run.sha256,
    finishedAt: run.finishedAt, error: run.error, createdAt: run.createdAt,
  };
}

/** Every read of a run re-resolves the definition's own permission, so a code revoked after the run was
 *  queued closes the download too. The gate is on the DEFINITION, never on who requested it. */
async function authoriseRun(c: Context<AppEnv>, companyId: string, run: ReportRunRow): Promise<void> {
  const loaded = await c.var.withTenant((tx) => loadRunDefinition(tx, run.id));
  if (loaded === null) throw new AppError("ERR_NOT_FOUND", `report run ${run.id} was not found`);
  await requireReportRead(c, companyId, parseReportDefinition(loaded.definition).permission);
}

reportRunRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema }), query: ReportRunQuery },
  responses: {
    200: { description: "Report runs", content: { "application/json": { schema: ReportRunList } } },
    400: { description: "Invalid", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  await requireReportExport(c, companyId);
  const filters = [
    ["status", q["filter[status][eq]"]], ["format", q["filter[format][eq]"]],
    ["lang", q["filter[lang][eq]"]], ["report_definition_id", q["filter[report_definition_id][eq]"]],
  ].filter((pair): pair is [string, string] => pair[1] !== undefined)
   .map(([field, value]) => ({ field, op: "eq", value }));

  let cursor: { createdAt: string; id: string } | null = null;
  if (q.cursor !== undefined) {
    const decoded = decodeCursor(q.cursor);
    const [createdAt] = decoded.k;
    if (typeof createdAt !== "string") {
      throw new AppError("ERR_VALIDATION_FAILED", "the cursor's keyset does not match this list's sort key");
    }
    cursor = { createdAt, id: decoded.id };
  }

  const rows = await c.var.withTenant((tx) => listReportRuns(tx, { companyId, filters, limit: q.limit, cursor }));
  const last = rows[rows.length - 1];
  return c.json({
    items: rows.map(toDto),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.createdAt], id: last.id })
      : null,
  }, 200);
});

reportRunRoutes.openapi(createRoute({
  method: "get", path: "/{runId}", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema, runId: UuidSchema }) },
  responses: {
    200: { description: "The run", content: { "application/json": { schema: ReportRunSchema } } },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Not found", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
}), async (c) => {
  const { companyId, runId } = c.req.valid("param");
  await requireReportExport(c, companyId);
  const run = await c.var.withTenant((tx) => getReportRun(tx, runId));
  if (run === null || run.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `report run ${runId} was not found`);
  }
  await authoriseRun(c, companyId, run);
  return c.json(toDto(run), 200);
});

reportRunRoutes.openapi(createRoute({
  method: "get", path: "/{runId}/content", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema, runId: UuidSchema }) },
  responses: {
    200: { description: "The rendered artefact" },
    403: { description: "Forbidden", content: { "application/problem+json": { schema: ProblemSchema } } },
    404: { description: "Not found or not finished", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
}), async (c) => {
  const { companyId, runId } = c.req.valid("param");
  // The download IS the export, so it carries the same gate as queuing one (spec:2146 `accounting.report.export`).
  await requireReportExport(c, companyId);
  const loaded = await c.var.withTenant((tx) => loadRunDefinition(tx, runId));
  if (loaded === null || loaded.run.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `report run ${runId} was not found`);
  }
  const definition = parseReportDefinition(loaded.definition);
  await requireReportRead(c, companyId, definition.permission);
  if (loaded.run.status !== "done" || loaded.run.objectKey === null) {
    throw new AppError(
      "ERR_NOT_FOUND",
      `report run ${runId} has not finished (status ${loaded.run.status})${loaded.run.error === null ? "" : `: ${loaded.run.error}`}`,
    );
  }
  const stored = await objectStore.get(loaded.run.objectKey);
  if (stored === null) {
    throw new AppError("ERR_NOT_FOUND", `the artefact of report run ${runId} is no longer in the store`);
  }
  return c.body(stored.bytes, 200, {
    "content-type": stored.contentType,
    // A file name a human recognises; the run id keeps two downloads distinguishable.
    "content-disposition": `attachment; filename="${definition.code}-${runId}.${loaded.run.format}"`,
    "cache-control": "private, no-store",
  });
});

  return reportRunRoutes;
}

/** The `permissions` array this module declares to `buildRoutes` (§4.2.7). Kept beside the factory so the
 *  registration in `routes/index.ts` is one line and the array is not re-typed there. */
export const REPORT_RUN_PERMISSIONS = [PERMISSION["accounting.report.export"]] as const;
```

**`authoriseRun` takes the plain Hono `Context<AppEnv>`** — the same type `requireReportRead` and
`requireReportExport` take (Step 2), and the same 0B gives `toProblem` and `resolveScope`. It is declared
inside the factory so it closes over nothing but the context it is handed; `objectStore` is used only by the
download route below.

- [ ] **Step 7: Register the module and its probe**

In `apps/api/src/routes/index.ts`, inside `buildRoutes` — never on the `ROUTES` array (§4.2.7):

```ts
    { path: REPORT_RUN_ROUTE_PATH, router: createReportRunRoutes(deps.objectStore),
      permissions: [...REPORT_RUN_PERMISSIONS], auth: "human" },
```

`buildRoutes`' `deps` parameter is already `{ authAdmin: AuthAdmin; objectStore: ObjectStore }` — 2C widened it for `createAttachmentRoutes` (§4.2.7) — so no signature changes here.

In `tests/invariants/probes.ts`:

```ts
  "/v1/companies/:companyId/report-runs": {
    async seed(db, owner) {
      const definitionId = await seedReportDefinition(db, owner, {
        code: "accounting.trial_balance", definition: PROBE_DEFINITION,
      });
      const runId = await withTenant(db.rw, owner.tenant, owner.human, async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into app.report_run (tenant_id, company_id, report_definition_id, parameters, format, lang, status)
          values (${owner.tenant}, ${owner.company}, ${definitionId}, '{}'::jsonb, 'csv', 'en', 'queued')
          returning id`;
        return row!.id;
      });
      return { path: `/v1/companies/${owner.company}/report-runs/${runId}`, method: "GET" };
    },
    expect: 403,
  },
```

**No `PROBES` entry for the runs sub-path.** `PROBES` is keyed by `RouteModule.path` (hazard 31) and `POST …/reports/{code}/runs` lives on 1B's `reports` module, which already has one.

- [ ] **Step 8: Extend 1B's route test and run everything**

Append one `it` to `apps/api/test/routes/accounting/reports.test.ts` asserting the sub-path is mounted on the same module and 1B's two `GET`s still answer:

```ts
  it("7A's runs sub-path is on THIS module, and 1B's two GETs are unchanged", async () => {
    const { ROUTES } = await import("@dulja/api/routes");
    const paths = ROUTES.filter((m) => m.path === "/v1/companies/:companyId/reports");
    expect(paths).toHaveLength(1);                     // one module on one path (hazard 31)
    for (const code of ["accounting.trial_balance", "accounting.ledger"]) {
      const res = await api.request({
        method: "GET", path: `/v1/companies/${s.company}/reports/${code}?fiscalPeriodId=${s.period}`, as: s.human,
      });
      expect([200, 400], code).toContain(res.status);   // 400 only when the code needs a parameter this call omits
    }
  });
```

Run: `bun run --cwd apps/api test -- routes/accounting/report-runs routes/accounting/reports && bun run --cwd tests test -- tenant-isolation && bun run lint:rules && bun run --cwd packages/contracts openapi:generate`
Expected: PASS throughout; `lint:rules` was already green from Task 3, which ships `requireReportExport` and with it the `PERMISSION["accounting.report.export"]` reference §3.6.3's `permission-catalogue` rule looks for. A red `permission-catalogue` here therefore means Step 4's appended helpers dropped or renamed that reference, not that this task was supposed to supply it. The OpenAPI regeneration produces a diff; commit `packages/contracts/openapi.json` with it (spec:2055).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/reports/authorise.ts apps/api/src/routes/accounting/report-runs.ts \
        apps/api/src/routes/accounting/reports.ts apps/api/src/routes/index.ts \
        packages/contracts/src/accounting/report-run.ts packages/contracts/src/index.ts \
        packages/contracts/openapi.json apps/api/test/routes/accounting/report-runs.test.ts \
        apps/api/test/routes/accounting/reports.test.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): add POST reports/{code}/runs and the run resource [7A T12]

The runs sub-path goes on 1B's reportsRouteModule, not a second module on the
same path (hazard 31). Both gates are inline app.actor_has pre-flights: the
definition's permission is a data value, PERMISSION["pos.report.read"] does not
compile before 6D, and assertRouteGates forbids a non-mutating code on an unsafe
method — which is exactly what lets the auditor export under R7. The run row and
the pg-boss job are one transaction, so a rollback leaves neither. statusUrl
points at the run resource per ADR 0067, because no slice mounts /v1/jobs/{jobId}.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: The report-definition API — clone and edit without a release — and saved views

**This task carries this slice's whole share of the Phase 7 definition of done:** "A user clones and edits a report without a release" (spec:2293). It ships the two configuration stores and the two route modules, and its central test clones a core definition, edits the clone, runs the clone, and asserts the core row is byte-unchanged.

**Three settlements this task records.**

1. **A clone takes `max(version) + 1`, not `2`.** §4.16.1 has 7B seed a re-expressed code at `version = 2` with `on conflict … do update`. A clone that took `2` would be silently overwritten when 7B ships. So `cloneReportDefinition` reads `max(version)` for the code and adds one; the seed loader's upsert additionally carries `where report_definition.is_core` and **fails loudly** rather than overwriting a tenant's row (Task 14).
2. **Definition writes are gated by `admin.company.manage`; reads by membership.** §3.6.2 fixes the first: "document types and posting policies, print templates … are maintained under `admin.company.manage`", and a report definition is the same class of configuration. The second follows §4.2.11's dimension precedent and §4.2.7's note on accounts and fiscal periods — the permission vocabulary is **closed** (§3.6.1) and contains no report-definition read code, so a slice inventing one would have to amend §3.6.2 first.
3. **A saved view carries no permission code at all.** It is personal state — a named parameter set the owner bookmarks — and §3.6.1's vocabulary has no code for it. The gates are membership (RLS), ownership (`owner_principal_id = app.current_actor()`, enforced in the store, not the handler) and the `shared` flag for reading. spec:106 asks every endpoint for a Zod schema, an OpenAPI entry, idempotency on unsafe methods and a tenant-isolation test — all four are here; it does not ask for a permission code, and inventing one would breach §3.6.1.

**Files:**
- Create: `packages/db/src/reports/definition-store.ts`, `packages/db/src/reports/saved-view-store.ts`, `packages/db/test/reports/definition-store.test.ts`, `packages/db/test/reports/saved-view-store.test.ts`, `packages/contracts/src/accounting/report-definition.ts`, `packages/contracts/src/accounting/saved-view.ts`, `apps/api/src/routes/accounting/report-definitions.ts`, `apps/api/src/routes/accounting/saved-views.ts`, `apps/api/test/routes/accounting/report-definitions.test.ts`, `apps/api/test/routes/accounting/saved-views.test.ts`
- Modify: `packages/db/src/reports/index.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/index.ts`, `tests/invariants/probes.ts`

**Interfaces:**
- Consumes: `validateReportDefinition`, `parseReportDefinition`, `ReportDefinitionError`, `ReportDefinition` (Task 4); `DATASET_IDS` (Task 7); `ReportError` (Task 5); **`assertDefinitionFields` (Task 9)** — the one field check, imported and never re-implemented; `statementDefinition` (Task 9, in the test only); `withTenant` (§4.2.2); `requirePermission`, `PERMISSION` (§4.2.5); `IdempotencyHeader`, `RouteModule` (§4.2.7); `UuidSchema`, `TimestampSchema`, `ListEnvelope`, `ListQuery`, `CursorSchema`, `encodeCursor`, `decodeCursor`, `ProblemSchema` (§4.2.8); `startApi`, `problemOf`, `grantAdmin` (§4.2.12, §4.17.1); `seedReportDefinition`, `grantCodes`, `seedTenantV2` (§4.17).
- Produces:

```ts
// packages/db/src/reports/definition-store.ts
export interface ReportDefinitionRow {
  id: string; companyId: string; code: string; version: number; definition: ReportDefinition;
  clonedFrom: string | null; isCore: boolean; archivedAt: string | null; createdAt: string;
}
export interface ReportDefinitionSetsSource { datasets: ReadonlySet<string>; permissions: ReadonlySet<string> }
/** Reads `select code from app.permission` on `tx` and pairs it with `DATASET_IDS` — the caller never passes
 *  `@dulja/contracts`' catalogue, because `packages/db` may not import it (§3.1; 1A's precedent). */
export async function reportDefinitionSets(tx: Sql): Promise<ReportDefinitionSetsSource>;
export async function getReportDefinition(tx: Sql, id: string): Promise<ReportDefinitionRow | null>;
export interface ListDefinitionsParams {
  companyId: string; code?: string; includeArchived?: boolean; limit: number;
  cursor?: { code: string; version: number } | null;
}
export async function listReportDefinitions(tx: Sql, params: ListDefinitionsParams): Promise<ReportDefinitionRow[]>;
export async function nextDefinitionVersion(tx: Sql, params: { companyId: string; code: string }): Promise<number>;
export async function createReportDefinition(
  tx: Sql, input: { companyId: string; definition: unknown; isCore?: boolean; clonedFrom?: string | null },
): Promise<ReportDefinitionRow>;
export async function cloneReportDefinition(
  tx: Sql, input: { companyId: string; sourceId: string; overrides?: Partial<ReportDefinition> },
): Promise<ReportDefinitionRow>;
/** A tenant version is edited in place; a CORE version is never mutated — `ERR_VALIDATION_FAILED` says to clone. */
export async function updateReportDefinition(
  tx: Sql, input: { id: string; definition: unknown },
): Promise<ReportDefinitionRow>;
export async function archiveReportDefinition(tx: Sql, id: string): Promise<void>;

// packages/db/src/reports/saved-view-store.ts
export interface SavedViewRow {
  id: string; companyId: string; reportDefinitionId: string; nameEn: string; nameAr: string | null;
  parameters: Readonly<Record<string, string>>; ownerPrincipalId: string; shared: boolean;
  archivedAt: string | null; createdAt: string;
}
export async function createSavedView(tx: Sql, input: { companyId: string; reportDefinitionId: string; nameEn: string; nameAr?: string | null; parameters: Readonly<Record<string, string>>; shared?: boolean }): Promise<SavedViewRow>;
export async function getSavedView(tx: Sql, id: string): Promise<SavedViewRow | null>;
export async function listSavedViews(tx: Sql, params: { companyId: string; reportDefinitionId?: string; limit: number; cursor?: { createdAt: string; id: string } | null }): Promise<SavedViewRow[]>;
/** Only the owner may change or archive a view; anyone else gets `ERR_RBAC_FORBIDDEN` from the store. */
export async function updateSavedView(tx: Sql, input: { id: string; nameEn?: string; nameAr?: string | null; parameters?: Readonly<Record<string, string>>; shared?: boolean }): Promise<SavedViewRow>;
export async function archiveSavedView(tx: Sql, id: string): Promise<void>;

// apps/api/src/routes/accounting/report-definitions.ts
export const reportDefinitionRoutes: OpenAPIHono<AppEnv>;
export const reportDefinitionRouteModule: RouteModule;    // "/v1/companies/:companyId/report-definitions"
// apps/api/src/routes/accounting/saved-views.ts
export const savedViewRoutes: OpenAPIHono<AppEnv>;
export const savedViewRouteModule: RouteModule;            // "/v1/companies/:companyId/saved-views"
```

- [ ] **Step 1: Write the failing store tests**

`packages/db/test/reports/definition-store.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  archiveReportDefinition, cloneReportDefinition, createReportDefinition, getReportDefinition,
  listReportDefinitions, nextDefinitionVersion, reportDefinitionSets, updateReportDefinition,
} from "../../src/reports/definition-store";
import { statementDefinition } from "@dulja/domain";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DEF = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read", parameters: [],
  dataset: { source: "account_balance", filters: [] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("the report_definition store", () => {
  let db: Db;
  let s: Seed;

  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "def-store"); });
  afterAll(async () => { await db.stop(); });

  const as = <T>(fn: Parameters<typeof withTenant>[3]) => withTenant(db.rw, s.tenant, s.human, fn) as Promise<T>;

  it("reportDefinitionSets reads the permission catalogue from the DATABASE, not from @dulja/contracts", async () => {
    const sets = await as<Awaited<ReturnType<typeof reportDefinitionSets>>>((tx) => reportDefinitionSets(tx));
    expect(sets.permissions.has("accounting.report.read")).toBe(true);
    expect(sets.permissions.has("accounting.report.export")).toBe(true);
    expect(sets.datasets.has("account_balance")).toBe(true);
    expect(sets.datasets.size).toBe(26);
  });

  it("creates a validated definition and refuses an invalid one with JSON-Pointer paths", async () => {
    const row = await as<Awaited<ReturnType<typeof createReportDefinition>>>((tx) =>
      createReportDefinition(tx, { companyId: s.company, definition: DEF, isCore: true }));
    expect(row.version).toBe(1);
    expect(row.isCore).toBe(true);
    expect(row.definition.code).toBe("accounting.trial_balance");

    await expect(as((tx) => createReportDefinition(tx, {
      companyId: s.company, definition: { ...DEF, code: "accounting.ledger", dataset: { source: "invoices", filters: [] } },
    }))).rejects.toThrowError(/\/dataset\/source/);
  });

  it("refuses a field the dataset does not serve — including in columns[], which nothing else checks", async () => {
    await expect(as((tx) => createReportDefinition(tx, {
      companyId: s.company,
      definition: {
        ...DEF, code: "accounting.period_comparison",
        columns: [{ field: "acount_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
      },
    }))).rejects.toThrowError(/dataset 'account_balance' has no such field: acount_code/);
  });

  it("STORES a statement definition, whose rows carry three fields its dataset does not declare", async () => {
    // Without `assertDefinitionFields`' STATEMENT_CODES union, this create would be refused
    // ("dataset 'account_balance' has no such field: section") and 7B could never seed
    // accounting.profit_and_loss or accounting.balance_sheet at all.
    const statement = statementDefinition("profit_and_loss", {
      code: "accounting.profit_and_loss", nameEn: "Profit and loss", nameAr: "الأرباح والخسائر",
      permission: "accounting.report.read",
    });
    const row = await as<Awaited<ReturnType<typeof createReportDefinition>>>((tx) =>
      createReportDefinition(tx, { companyId: s.company, definition: statement, isCore: true }));
    expect(row.definition.groups.map((g) => g.field)).toEqual(["section"]);

    // And the per-BRANCH variant, whose `branch_code` column and `branch_id` filter are served by the
    // `ledger_entry` read `statementRows` performs (spec:1066).
    const branch = statementDefinition("profit_and_loss", {
      code: "accounting.branch_profit_and_loss", nameEn: "Branch P&L", nameAr: "أرباح الفرع",
      permission: "accounting.report.read",
    }, { perBranch: true });
    await expect(as((tx) => createReportDefinition(tx, { companyId: s.company, definition: branch, isCore: true })))
      .resolves.toMatchObject({ isCore: true });
  });

  it("a clone takes max(version) + 1, is is_core false, and records cloned_from", async () => {
    const core = await seedReportDefinition(db, s, { code: "accounting.ledger", definition: { ...DEF, code: "accounting.ledger" } });
    expect(await as<number>((tx) => nextDefinitionVersion(tx, { companyId: s.company, code: "accounting.ledger" }))).toBe(2);
    const clone = await as<Awaited<ReturnType<typeof cloneReportDefinition>>>((tx) =>
      cloneReportDefinition(tx, { companyId: s.company, sourceId: core }));
    expect(clone.version).toBe(2);
    expect(clone.isCore).toBe(false);
    expect(clone.clonedFrom).toBe(core);
    // 7B seeds a re-expressed code at version 2 with an upsert; a clone that took 2 as a literal would be
    // silently overwritten by that seed. max(version) + 1 is what makes the two coexist (§4.16.1).
    const second = await as<Awaited<ReturnType<typeof cloneReportDefinition>>>((tx) =>
      cloneReportDefinition(tx, { companyId: s.company, sourceId: core }));
    expect(second.version).toBe(3);
  });

  it("a clone may override any part of the definition, and the result is re-validated", async () => {
    const core = await seedReportDefinition(db, s, { code: "accounting.general_ledger", definition: { ...DEF, code: "accounting.general_ledger" } });
    const clone = await as<Awaited<ReturnType<typeof cloneReportDefinition>>>((tx) =>
      cloneReportDefinition(tx, {
        companyId: s.company, sourceId: core,
        overrides: { nameEn: "My GL", columns: [{ field: "account_name_en", labelEn: "Name", labelAr: "الاسم", format: "text", align: "start" }] },
      }));
    expect(clone.definition.nameEn).toBe("My GL");
    expect(clone.definition.columns).toHaveLength(1);

    await expect(as((tx) => cloneReportDefinition(tx, {
      companyId: s.company, sourceId: core, overrides: { code: "accounting.report.read" },
    }))).rejects.toThrowError(/\/code/);
  });

  it("edits a tenant version in place and refuses to mutate a CORE version", async () => {
    const core = await seedReportDefinition(db, s, { code: "accounting.journal_register", definition: { ...DEF, code: "accounting.journal_register" }, isCore: true });
    const clone = await as<Awaited<ReturnType<typeof cloneReportDefinition>>>((tx) =>
      cloneReportDefinition(tx, { companyId: s.company, sourceId: core }));
    const edited = await as<Awaited<ReturnType<typeof updateReportDefinition>>>((tx) =>
      updateReportDefinition(tx, { id: clone.id, definition: { ...clone.definition, nameEn: "Edited" } }));
    expect(edited.nameEn ?? edited.definition.nameEn).toBe("Edited");

    await expect(as((tx) => updateReportDefinition(tx, { id: core, definition: { ...DEF, code: "accounting.journal_register", nameEn: "No" } })))
      .rejects.toThrowError(/is a core definition; clone it/);
  });

  it("archives rather than deletes, and an archived version drops out of the list", async () => {
    const id = await seedReportDefinition(db, s, { code: "accounting.account_statement", definition: { ...DEF, code: "accounting.account_statement" } });
    await as((tx) => archiveReportDefinition(tx, id));
    expect((await as<Awaited<ReturnType<typeof getReportDefinition>>>((tx) => getReportDefinition(tx, id)))!.archivedAt).not.toBeNull();
    const live = await as<Awaited<ReturnType<typeof listReportDefinitions>>>((tx) =>
      listReportDefinitions(tx, { companyId: s.company, code: "accounting.account_statement", limit: 100 }));
    expect(live).toEqual([]);
    const all = await as<Awaited<ReturnType<typeof listReportDefinitions>>>((tx) =>
      listReportDefinitions(tx, { companyId: s.company, code: "accounting.account_statement", includeArchived: true, limit: 100 }));
    expect(all).toHaveLength(1);
  });
});
```

`packages/db/test/reports/saved-view-store.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  archiveSavedView, createSavedView, getSavedView, listSavedViews, updateSavedView,
} from "../../src/reports/saved-view-store";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const DEF = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: { source: "account_balance", filters: [] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("the saved_view store", () => {
  let db: Db;
  let s: Seed;
  let definitionId: string;
  let colleague: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "view-store");
    definitionId = await seedReportDefinition(db, s, { code: "accounting.trial_balance", definition: DEF });
    colleague = await uuidv7(db.admin);
    await db.admin`insert into app.principal (id, kind, auth_subject, display_name) values (${colleague}, 'human', ${`sub:${colleague}`}, 'Colleague')`;
    await db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${colleague})`;
  });
  afterAll(async () => { await db.stop(); });

  it("stamps the owner from the session and refuses a parameter the definition does not declare", async () => {
    const view = await withTenant(db.rw, s.tenant, s.human, (tx) => createSavedView(tx, {
      companyId: s.company, reportDefinitionId: definitionId, nameEn: "Q1", parameters: { fiscalPeriodId: s.period },
    }));
    expect(view.ownerPrincipalId).toBe(s.human);
    expect(view.shared).toBe(false);

    await expect(withTenant(db.rw, s.tenant, s.human, (tx) => createSavedView(tx, {
      companyId: s.company, reportDefinitionId: definitionId, nameEn: "Bad", parameters: { nope: "x" },
    }))).rejects.toThrowError(/declares no such parameter/);
  });

  it("lists a principal's own views plus the company's shared ones, never a colleague's private view", async () => {
    await withTenant(db.rw, s.tenant, colleague, (tx) => createSavedView(tx, {
      companyId: s.company, reportDefinitionId: definitionId, nameEn: "Theirs private", parameters: {},
    }));
    await withTenant(db.rw, s.tenant, colleague, (tx) => createSavedView(tx, {
      companyId: s.company, reportDefinitionId: definitionId, nameEn: "Theirs shared", parameters: {}, shared: true,
    }));
    const mine = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      listSavedViews(tx, { companyId: s.company, limit: 100 }));
    const names = mine.map((v) => v.nameEn);
    expect(names).toContain("Q1");
    expect(names).toContain("Theirs shared");
    expect(names).not.toContain("Theirs private");
  });

  it("only the owner may update or archive; a colleague gets ERR_RBAC_FORBIDDEN from the STORE", async () => {
    const view = await withTenant(db.rw, s.tenant, s.human, (tx) => createSavedView(tx, {
      companyId: s.company, reportDefinitionId: definitionId, nameEn: "Mine", parameters: {},
    }));
    await expect(withTenant(db.rw, s.tenant, colleague, (tx) => updateSavedView(tx, { id: view.id, nameEn: "Hijacked" })))
      .rejects.toThrowError(/only its owner may change a saved view/);
    await expect(withTenant(db.rw, s.tenant, colleague, (tx) => archiveSavedView(tx, view.id)))
      .rejects.toThrowError(/only its owner may change a saved view/);
    const updated = await withTenant(db.rw, s.tenant, s.human, (tx) => updateSavedView(tx, { id: view.id, shared: true }));
    expect(updated.shared).toBe(true);
  });

  it("archive sets archived_at and never issues a DELETE (spec:2049, hazard 25)", async () => {
    const view = await withTenant(db.rw, s.tenant, s.human, (tx) => createSavedView(tx, {
      companyId: s.company, reportDefinitionId: definitionId, nameEn: "Gone", parameters: {},
    }));
    await withTenant(db.rw, s.tenant, s.human, (tx) => archiveSavedView(tx, view.id));
    expect((await withTenant(db.rw, s.tenant, s.human, (tx) => getSavedView(tx, view.id)))!.archivedAt).not.toBeNull();
    const live = await withTenant(db.rw, s.tenant, s.human, (tx) => listSavedViews(tx, { companyId: s.company, limit: 100 }));
    expect(live.map((v) => v.nameEn)).not.toContain("Gone");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun run --cwd packages/db test -- reports/definition-store reports/saved-view-store`
Expected: FAIL — both files fail to resolve their imports.

- [ ] **Step 3: Write the definition store**

`packages/db/src/reports/definition-store.ts`:

```ts
import type { Sql } from "postgres";
import { parseReportDefinition, validateReportDefinition, type ReportDefinition } from "@dulja/domain";
import { DATASET_IDS } from "./datasets";
import { ReportError } from "./errors";
import { assertDefinitionFields } from "./statement";     // Task 9 — the one field check

export interface ReportDefinitionRow {
  id: string; companyId: string; code: string; version: number; definition: ReportDefinition;
  clonedFrom: string | null; isCore: boolean; archivedAt: string | null; createdAt: string;
}

export interface ReportDefinitionSetsSource { datasets: ReadonlySet<string>; permissions: ReadonlySet<string> }

/**
 * The two closed sets `validateReportDefinition` needs, read from where they actually live at run time:
 * `DATASET_IDS` (this package) and `select code from app.permission` (global, no RLS, one writer per slice's
 * migration — plan0A:1313). `packages/db` may not import `@dulja/contracts` (§3.1), and 0B's
 * `permission-catalogue.test.ts` asserts the table equals `PERMISSIONS` in both directions, so the two
 * sources cannot disagree. This is 1A's `loadDocumentTypes` decision applied here.
 */
export async function reportDefinitionSets(tx: Sql): Promise<ReportDefinitionSetsSource> {
  const rows = await tx<{ code: string }[]>`select code from app.permission`;
  return { datasets: new Set(DATASET_IDS), permissions: new Set(rows.map((r) => r.code)) };
}

function selectList(tx: Sql) {
  return tx`d.id, d.company_id, d.code, d.version, d.definition, d.cloned_from, d.is_core,
            to_char(d.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at,
            to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;
}

interface RawDefinition {
  id: string; company_id: string; code: string; version: number; definition: unknown;
  cloned_from: string | null; is_core: boolean; archived_at: string | null; created_at: string;
}

function toRow(raw: RawDefinition): ReportDefinitionRow {
  return {
    id: raw.id, companyId: raw.company_id, code: raw.code, version: raw.version,
    definition: parseReportDefinition(raw.definition), clonedFrom: raw.cloned_from,
    isCore: raw.is_core, archivedAt: raw.archived_at, createdAt: raw.created_at,
  };
}

export async function getReportDefinition(tx: Sql, id: string): Promise<ReportDefinitionRow | null> {
  const [raw] = await tx<RawDefinition[]>`select ${selectList(tx)} from app.report_definition d where d.id = ${id}`;
  return raw === undefined ? null : toRow(raw);
}

export interface ListDefinitionsParams {
  companyId: string; code?: string; includeArchived?: boolean; limit: number;
  cursor?: { code: string; version: number } | null;
}

export async function listReportDefinitions(
  tx: Sql, params: ListDefinitionsParams,
): Promise<ReportDefinitionRow[]> {
  const byCode = params.code === undefined ? tx`` : tx`and d.code = ${params.code}`;
  const archived = params.includeArchived === true ? tx`` : tx`and d.archived_at is null`;
  const keyset = params.cursor == null
    ? tx``
    : tx`and (d.code, d.version) > (${params.cursor.code}, ${params.cursor.version})`;
  const raws = await tx<RawDefinition[]>`
    select ${selectList(tx)}
      from app.report_definition d
     where d.company_id = ${params.companyId}::uuid ${byCode} ${archived} ${keyset}
     order by d.code asc, d.version asc
     limit ${Math.min(Math.max(params.limit, 1), 1000)}`;
  return raws.map(toRow);
}

export async function nextDefinitionVersion(
  tx: Sql, params: { companyId: string; code: string },
): Promise<number> {
  // `coalesce(max(version), 0) + 1`, over EVERY version including archived ones: reusing an archived version
  // number would collide on the unique key and would make the version history lie.
  const [row] = await tx<{ next: number }[]>`
    select coalesce(max(d.version), 0) + 1 as next
      from app.report_definition d
     where d.company_id = ${params.companyId}::uuid and d.code = ${params.code}`;
  return row!.next;
}

function assertValid(definition: unknown, sets: ReportDefinitionSetsSource): ReportDefinition {
  const result = validateReportDefinition(definition, sets);
  if (!result.ok) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report definition is invalid: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
    );
  }
  const parsed = parseReportDefinition(definition);
  // The ONE field check (Task 9, `packages/db/src/reports/statement.ts`) — the same function the seed loader
  // calls, so a definition written by hand through the API and one shipped in a pack are held to one rule.
  // It is NOT a module-private copy here: a second spelling would drift, and it is the function that knows
  // a statement code's rows carry `section` / `branch_code` / `branch_id` on top of its dataset's columns.
  assertDefinitionFields(parsed);
  return parsed;
}

export async function createReportDefinition(
  tx: Sql,
  input: { companyId: string; definition: unknown; isCore?: boolean; clonedFrom?: string | null },
): Promise<ReportDefinitionRow> {
  const sets = await reportDefinitionSets(tx);
  const definition = assertValid(input.definition, sets);
  const version = await nextDefinitionVersion(tx, { companyId: input.companyId, code: definition.code });
  const [raw] = await tx<RawDefinition[]>`
    insert into app.report_definition (tenant_id, company_id, code, version, definition, is_core, cloned_from)
    values (app.current_tenant(), ${input.companyId}, ${definition.code}, ${version},
            ${JSON.stringify(definition)}::jsonb, ${input.isCore ?? false}, ${input.clonedFrom ?? null})
    returning ${selectList(tx)}`;
  return toRow(raw!);
}

/**
 * The DoD's clone: `max(version) + 1`, `is_core = false`, `cloned_from` set. The overrides are applied to the
 * source definition and the RESULT is re-validated, so a clone can never be invalid in a way the source was
 * not — and a clone that changed `code` is refused, because a code is the identity a run resolves by.
 */
export async function cloneReportDefinition(
  tx: Sql,
  input: { companyId: string; sourceId: string; overrides?: Partial<ReportDefinition> },
): Promise<ReportDefinitionRow> {
  const source = await getReportDefinition(tx, input.sourceId);
  if (source === null || source.companyId !== input.companyId) {
    throw new ReportError("ERR_NOT_FOUND", `report definition ${input.sourceId} was not found in this company`);
  }
  const merged = { ...source.definition, ...(input.overrides ?? {}), code: source.definition.code };
  if (input.overrides?.code !== undefined && input.overrides.code !== source.definition.code) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `/code a clone keeps its source's code '${source.definition.code}'; a new code is a new report and needs a §4.16.1 row`,
    );
  }
  return createReportDefinition(tx, {
    companyId: input.companyId, definition: merged, isCore: false, clonedFrom: source.id,
  });
}

export async function updateReportDefinition(
  tx: Sql, input: { id: string; definition: unknown },
): Promise<ReportDefinitionRow> {
  const existing = await getReportDefinition(tx, input.id);
  if (existing === null) {
    throw new ReportError("ERR_NOT_FOUND", `report definition ${input.id} was not found`);
  }
  if (existing.isCore) {
    // A core row is the seed pack's, and the seed re-applies it after every deploy (§3.4.8) — an in-place edit
    // would be silently reverted, which is worse than a refusal.
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `report definition ${input.id} is a core definition; clone it and edit the clone (the seed pack re-applies core rows on every deploy)`,
    );
  }
  const sets = await reportDefinitionSets(tx);
  const definition = assertValid(input.definition, sets);
  if (definition.code !== existing.code) {
    throw new ReportError("ERR_VALIDATION_FAILED", `/code an edit cannot change a definition's code`);
  }
  const [raw] = await tx<RawDefinition[]>`
    update app.report_definition d set definition = ${JSON.stringify(definition)}::jsonb
     where d.id = ${input.id} and d.archived_at is null
    returning ${selectList(tx)}`;
  if (raw === undefined) {
    throw new ReportError("ERR_VALIDATION_FAILED", `report definition ${input.id} is archived and cannot be edited`);
  }
  return toRow(raw);
}

/** Archived, never deleted (spec:2049). No DELETE grant exists on this table (§3.5.4). */
export async function archiveReportDefinition(tx: Sql, id: string): Promise<void> {
  const rows = await tx`update app.report_definition set archived_at = now() where id = ${id} and archived_at is null`;
  if (rows.count === 0) {
    throw new ReportError("ERR_NOT_FOUND", `report definition ${id} was not found or is already archived`);
  }
}
```

- [ ] **Step 4: Write the saved-view store**

`packages/db/src/reports/saved-view-store.ts`:

```ts
import type { Sql } from "postgres";
import { parseReportDefinition } from "@dulja/domain";
import { ReportError } from "./errors";

export interface SavedViewRow {
  id: string; companyId: string; reportDefinitionId: string; nameEn: string; nameAr: string | null;
  parameters: Readonly<Record<string, string>>; ownerPrincipalId: string; shared: boolean;
  archivedAt: string | null; createdAt: string;
}

function selectList(tx: Sql) {
  return tx`v.id, v.company_id, v.report_definition_id, v.name_en, v.name_ar, v.parameters,
            v.owner_principal_id, v.shared,
            to_char(v.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at,
            to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at`;
}

interface RawView {
  id: string; company_id: string; report_definition_id: string; name_en: string; name_ar: string | null;
  parameters: Record<string, string>; owner_principal_id: string; shared: boolean;
  archived_at: string | null; created_at: string;
}

function toRow(raw: RawView): SavedViewRow {
  return {
    id: raw.id, companyId: raw.company_id, reportDefinitionId: raw.report_definition_id,
    nameEn: raw.name_en, nameAr: raw.name_ar, parameters: raw.parameters,
    ownerPrincipalId: raw.owner_principal_id, shared: raw.shared,
    archivedAt: raw.archived_at, createdAt: raw.created_at,
  };
}

/** A saved view's parameters must be a subset of the definition's own declaration, or the view would fail at
 *  render time rather than at save time — LEGACY-078's lesson applied to a bookmark. */
async function assertParameters(
  tx: Sql, reportDefinitionId: string, parameters: Readonly<Record<string, string>>,
): Promise<void> {
  const [row] = await tx<{ definition: unknown }[]>`
    select definition from app.report_definition where id = ${reportDefinitionId} and archived_at is null`;
  if (row === undefined) {
    throw new ReportError("ERR_NOT_FOUND", `report definition ${reportDefinitionId} was not found or is archived`);
  }
  const declared = new Set(parseReportDefinition(row.definition).parameters.map((p) => p.name));
  const unknown = Object.keys(parameters).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new ReportError(
      "ERR_VALIDATION_FAILED",
      `this report declares no such parameter: ${unknown.join(", ")}`,
    );
  }
}

export async function createSavedView(
  tx: Sql,
  input: {
    companyId: string; reportDefinitionId: string; nameEn: string; nameAr?: string | null;
    parameters: Readonly<Record<string, string>>; shared?: boolean;
  },
): Promise<SavedViewRow> {
  await assertParameters(tx, input.reportDefinitionId, input.parameters);
  const [raw] = await tx<RawView[]>`
    insert into app.saved_view
      (tenant_id, company_id, report_definition_id, name_en, name_ar, parameters, shared)
    values (app.current_tenant(), ${input.companyId}, ${input.reportDefinitionId}, ${input.nameEn},
            ${input.nameAr ?? null}, ${JSON.stringify(input.parameters)}::jsonb, ${input.shared ?? false})
    returning ${selectList(tx)}`;
  // owner_principal_id takes its column default `app.current_actor()`, so the owner is the session's — never
  // a payload field (§3.3's rule for attributed columns, and LEGACY-044's lesson for acting ones).
  return toRow(raw!);
}

export async function getSavedView(tx: Sql, id: string): Promise<SavedViewRow | null> {
  const [raw] = await tx<RawView[]>`select ${selectList(tx)} from app.saved_view v where v.id = ${id}`;
  return raw === undefined ? null : toRow(raw);
}

export async function listSavedViews(
  tx: Sql,
  params: { companyId: string; reportDefinitionId?: string; limit: number; cursor?: { createdAt: string; id: string } | null },
): Promise<SavedViewRow[]> {
  const byDefinition = params.reportDefinitionId === undefined
    ? tx``
    : tx`and v.report_definition_id = ${params.reportDefinitionId}::uuid`;
  const keyset = params.cursor == null
    ? tx``
    : tx`and (v.created_at, v.id) < (${params.cursor.createdAt}::timestamptz, ${params.cursor.id}::uuid)`;
  const raws = await tx<RawView[]>`
    select ${selectList(tx)}
      from app.saved_view v
     where v.company_id = ${params.companyId}::uuid
       and v.archived_at is null
       -- Mine, or the company's shared ones. RLS is tenant-scoped, so this predicate is what keeps a
       -- colleague's private bookmark private (§4.11.2's `shared` column is the whole visibility model).
       and (v.owner_principal_id = app.current_actor() or v.shared)
       ${byDefinition} ${keyset}
     order by v.created_at desc, v.id desc
     limit ${Math.min(Math.max(params.limit, 1), 1000)}`;
  return raws.map(toRow);
}

async function assertOwner(tx: Sql, id: string): Promise<SavedViewRow> {
  const view = await getSavedView(tx, id);
  if (view === null) throw new ReportError("ERR_NOT_FOUND", `saved view ${id} was not found`);
  const [row] = await tx<{ actor: string }[]>`select app.current_actor() as actor`;
  if (view.ownerPrincipalId !== row!.actor) {
    // ERR_RBAC_FORBIDDEN, which §4.2.4 maps to 403 - not ERR_VALIDATION_FAILED. The request is
    // well-formed; the caller is simply not this bookmark's owner, and answering 400 would tell a client
    // to fix a payload that has nothing wrong with it. This is the fourth member of `ReportErrorCode`
    // and the only reason it exists.
    throw new ReportError(
      "ERR_RBAC_FORBIDDEN",
      `only its owner may change a saved view; view ${id} belongs to another principal`,
    );
  }
  return view;
}

export async function updateSavedView(
  tx: Sql,
  input: { id: string; nameEn?: string; nameAr?: string | null; parameters?: Readonly<Record<string, string>>; shared?: boolean },
): Promise<SavedViewRow> {
  const view = await assertOwner(tx, input.id);
  if (input.parameters !== undefined) {
    await assertParameters(tx, view.reportDefinitionId, input.parameters);
  }
  const [raw] = await tx<RawView[]>`
    update app.saved_view v
       set name_en    = ${input.nameEn ?? view.nameEn},
           name_ar    = ${input.nameAr === undefined ? view.nameAr : input.nameAr},
           parameters = ${JSON.stringify(input.parameters ?? view.parameters)}::jsonb,
           shared     = ${input.shared ?? view.shared}
     where v.id = ${input.id} and v.archived_at is null
    returning ${selectList(tx)}`;
  if (raw === undefined) {
    throw new ReportError("ERR_VALIDATION_FAILED", `saved view ${input.id} is archived and cannot be changed`);
  }
  return toRow(raw);
}

/** Archived, never deleted (spec:2049, hazard 25). `app_rw` holds no DELETE on this table. */
export async function archiveSavedView(tx: Sql, id: string): Promise<void> {
  await assertOwner(tx, id);
  await tx`update app.saved_view set archived_at = now() where id = ${id} and archived_at is null`;
}
```

Add both stores' exports to `packages/db/src/reports/index.ts`.

- [ ] **Step 5: Run the store tests to see them pass**

Run: `bun run --cwd packages/db test -- reports/definition-store reports/saved-view-store`
Expected: PASS — every `it` in both files.

- [ ] **Step 6: Write the two contracts modules and the two route modules**

`packages/contracts/src/accounting/report-definition.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";
import { ReportParametersSchema } from "./report-run";

/** The `code` grammar of §4.16.1 — two segments, the first a module. The FULL definition body is validated by
 *  `validateReportDefinition` in the store (Task 4), not twice in Zod: one validator, one set of messages. */
export const ReportDefinitionCodeSchema = z.string()
  .regex(/^(accounting|inventory|hr|pos)\.[a-z][a-z0-9_]{2,47}$/)
  .openapi("ReportDefinitionCode");

/** `passthrough`, deliberately: the JSON Schema is `additionalProperties: false` and the store enforces it, so
 *  a second closed shape here would be two spellings of one format (hazard 9) that could disagree. */
export const ReportDefinitionBodySchema = z.object({
  version: z.literal(1),
  code: ReportDefinitionCodeSchema,
  nameEn: z.string().min(1),
  nameAr: z.string().min(1),
}).passthrough().openapi("ReportDefinitionBody");

export const ReportDefinitionSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  code: ReportDefinitionCodeSchema,
  version: z.number().int().positive(),
  definition: ReportDefinitionBodySchema,
  clonedFrom: UuidSchema.nullable(),
  isCore: z.boolean(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
}).openapi("ReportDefinition");

export const CreateReportDefinitionBody = z.object({ definition: ReportDefinitionBodySchema })
  .openapi("CreateReportDefinitionBody");
export const UpdateReportDefinitionBody = z.object({ definition: ReportDefinitionBodySchema })
  .openapi("UpdateReportDefinitionBody");
/** Every member optional: a clone with no overrides is a verbatim copy at the next version. */
export const CloneReportDefinitionBody = z.object({ overrides: z.record(z.unknown()).optional() })
  .openapi("CloneReportDefinitionBody");
export const ReportDefinitionQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  "filter[code][eq]": ReportDefinitionCodeSchema.optional(),
  "filter[archived][eq]": z.enum(["true", "false"]).optional(),
}).openapi("ReportDefinitionQuery");
export const ReportDefinitionList = ListEnvelope(ReportDefinitionSchema).openapi("ReportDefinitionList");
export { ReportParametersSchema };
```

`packages/contracts/src/accounting/saved-view.ts`:

```ts
import { z } from "@hono/zod-openapi";
import { CursorSchema, ListEnvelope, TimestampSchema, UuidSchema } from "../common";
import { ReportParametersSchema } from "./report-run";

export const SavedViewSchema = z.object({
  id: UuidSchema,
  companyId: UuidSchema,
  reportDefinitionId: UuidSchema,
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().min(1).max(120).nullable(),
  parameters: ReportParametersSchema,
  ownerPrincipalId: UuidSchema,
  shared: z.boolean(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
}).openapi("SavedView");

export const CreateSavedViewBody = z.object({
  reportDefinitionId: UuidSchema,
  nameEn: z.string().min(1).max(120),
  nameAr: z.string().min(1).max(120).optional(),
  parameters: ReportParametersSchema.default({}),
  shared: z.boolean().default(false),
  // `ownerPrincipalId` is deliberately ABSENT: the column defaults to app.current_actor(), so a payload can
  // never claim another principal's bookmark (§3.3, LEGACY-044's lesson applied to an attributed column).
}).openapi("CreateSavedViewBody");

export const UpdateSavedViewBody = z.object({
  nameEn: z.string().min(1).max(120).optional(),
  nameAr: z.string().min(1).max(120).nullable().optional(),
  parameters: ReportParametersSchema.optional(),
  shared: z.boolean().optional(),
}).openapi("UpdateSavedViewBody");

export const SavedViewQuery = z.object({
  cursor: CursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  "filter[report_definition_id][eq]": UuidSchema.optional(),
}).openapi("SavedViewQuery");

export const SavedViewList = ListEnvelope(SavedViewSchema).openapi("SavedViewList");
```

`apps/api/src/routes/accounting/report-definitions.ts` — six routes; the writes carry `requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" })`, the reads carry none:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  CloneReportDefinitionBody, CreateReportDefinitionBody, ProblemSchema, ReportDefinitionList,
  ReportDefinitionQuery, ReportDefinitionSchema, UpdateReportDefinitionBody, UuidSchema,
  decodeCursor, encodeCursor,
} from "@dulja/contracts";
import { PERMISSION } from "@dulja/contracts/permissions";
import { AppError } from "@dulja/contracts";
import {
  archiveReportDefinition, cloneReportDefinition, createReportDefinition, getReportDefinition,
  listReportDefinitions, updateReportDefinition, type ReportDefinitionRow,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader, type RouteModule } from "../index";
import { requirePermission } from "../../middleware/require-permission";

export const reportDefinitionRoutes = new OpenAPIHono<AppEnv>();

const manage = requirePermission(PERMISSION["admin.company.manage"], { company: "path:companyId" });

function toDto(row: ReportDefinitionRow) {
  return {
    id: row.id, companyId: row.companyId, code: row.code, version: row.version,
    definition: row.definition, clonedFrom: row.clonedFrom, isCore: row.isCore,
    archivedAt: row.archivedAt, createdAt: row.createdAt,
  };
}

const problem = (status: number) => ({
  description: "Problem", content: { "application/problem+json": { schema: ProblemSchema } },
});

// ── list (membership only — §4.2.11's dimension precedent; §3.6.1 has no report-definition read code) ──
reportDefinitionRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema }), query: ReportDefinitionQuery },
  responses: { 200: { description: "Definitions", content: { "application/json": { schema: ReportDefinitionList } } }, 400: problem(400) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  let cursor: { code: string; version: number } | null = null;
  if (q.cursor !== undefined) {
    const decoded = decodeCursor(q.cursor);
    const [code, version] = decoded.k;
    if (typeof code !== "string" || typeof version !== "number") {
      throw new AppError("ERR_VALIDATION_FAILED", "the cursor's keyset does not match this list's sort key");
    }
    cursor = { code, version };
  }
  const rows = await c.var.withTenant((tx) => listReportDefinitions(tx, {
    companyId, code: q["filter[code][eq]"], includeArchived: q["filter[archived][eq]"] === "true",
    limit: q.limit, cursor,
  }));
  const last = rows[rows.length - 1];
  return c.json({
    items: rows.map(toDto),
    next_cursor: rows.length === q.limit && last !== undefined ? encodeCursor({ k: [last.code, last.version], id: last.id }) : null,
  }, 200);
});

reportDefinitionRoutes.openapi(createRoute({
  method: "get", path: "/{definitionId}", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema, definitionId: UuidSchema }) },
  responses: { 200: { description: "The definition", content: { "application/json": { schema: ReportDefinitionSchema } } }, 404: problem(404) },
}), async (c) => {
  const { companyId, definitionId } = c.req.valid("param");
  const row = await c.var.withTenant((tx) => getReportDefinition(tx, definitionId));
  if (row === null || row.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `report definition ${definitionId} was not found`);
  }
  return c.json(toDto(row), 200);
});

reportDefinitionRoutes.openapi(createRoute({
  method: "post", path: "/", tags: ["reports"], middleware: [manage],
  request: {
    headers: IdempotencyHeader, params: z.object({ companyId: UuidSchema }),
    body: { content: { "application/json": { schema: CreateReportDefinitionBody } } },
  },
  responses: { 201: { description: "Created", content: { "application/json": { schema: ReportDefinitionSchema } } }, 400: problem(400), 403: problem(403) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const { definition } = c.req.valid("json");
  const row = await c.var.withTenant((tx) => createReportDefinition(tx, { companyId, definition, isCore: false }));
  return c.json(toDto(row), 201);
});

// ── THE DoD ROUTE: clone-and-edit without a release (spec:2293) ────────────────────────────────────
reportDefinitionRoutes.openapi(createRoute({
  method: "post", path: "/{definitionId}/clone", tags: ["reports"], middleware: [manage],
  request: {
    headers: IdempotencyHeader, params: z.object({ companyId: UuidSchema, definitionId: UuidSchema }),
    body: { content: { "application/json": { schema: CloneReportDefinitionBody } } },
  },
  responses: { 201: { description: "The clone", content: { "application/json": { schema: ReportDefinitionSchema } } }, 400: problem(400), 403: problem(403), 404: problem(404) },
}), async (c) => {
  const { companyId, definitionId } = c.req.valid("param");
  const { overrides } = c.req.valid("json");
  const row = await c.var.withTenant((tx) => cloneReportDefinition(tx, {
    companyId, sourceId: definitionId, overrides: overrides as never,
  }));
  return c.json(toDto(row), 201);
});

reportDefinitionRoutes.openapi(createRoute({
  method: "put", path: "/{definitionId}", tags: ["reports"], middleware: [manage],
  request: {
    headers: IdempotencyHeader, params: z.object({ companyId: UuidSchema, definitionId: UuidSchema }),
    body: { content: { "application/json": { schema: UpdateReportDefinitionBody } } },
  },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: ReportDefinitionSchema } } }, 400: problem(400), 403: problem(403), 404: problem(404) },
}), async (c) => {
  const { companyId, definitionId } = c.req.valid("param");
  const { definition } = c.req.valid("json");
  const existing = await c.var.withTenant((tx) => getReportDefinition(tx, definitionId));
  if (existing === null || existing.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `report definition ${definitionId} was not found`);
  }
  const row = await c.var.withTenant((tx) => updateReportDefinition(tx, { id: definitionId, definition }));
  return c.json(toDto(row), 200);
});

reportDefinitionRoutes.openapi(createRoute({
  method: "post", path: "/{definitionId}/archive", tags: ["reports"], middleware: [manage],
  request: { headers: IdempotencyHeader, params: z.object({ companyId: UuidSchema, definitionId: UuidSchema }) },
  responses: { 204: { description: "Archived" }, 403: problem(403), 404: problem(404) },
}), async (c) => {
  const { companyId, definitionId } = c.req.valid("param");
  const existing = await c.var.withTenant((tx) => getReportDefinition(tx, definitionId));
  if (existing === null || existing.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `report definition ${definitionId} was not found`);
  }
  await c.var.withTenant((tx) => archiveReportDefinition(tx, definitionId));
  return c.body(null, 204);
});

export const reportDefinitionRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/report-definitions",
  router: reportDefinitionRoutes,
  permissions: [PERMISSION["admin.company.manage"]],
  auth: "human",
};
```

`apps/api/src/routes/accounting/saved-views.ts` — five routes, in full, with **no `requirePermission` on any of them**. `problem` is the same local helper the definitions module above declares, and `IdempotencyHeader`/`RouteModule` come from the routes barrel exactly as they do there — not from `@dulja/contracts`, which is where a reader would expect them and where they are not exported:

```ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AppError, CreateSavedViewBody, ProblemSchema, SavedViewList, SavedViewQuery,
  SavedViewSchema, UpdateSavedViewBody, UuidSchema, decodeCursor, encodeCursor,
} from "@dulja/contracts";
import {
  archiveSavedView, createSavedView, getSavedView, listSavedViews, updateSavedView, type SavedViewRow,
} from "@dulja/db";
import type { AppEnv } from "../../context";
import { IdempotencyHeader, type RouteModule } from "../index";

const savedViewRoutes = new OpenAPIHono<AppEnv>();

const problem = (status: 400 | 403 | 404) => ({
  description: "Problem", content: { "application/problem+json": { schema: ProblemSchema } },
});

function toDto(v: SavedViewRow) {
  return {
    id: v.id, companyId: v.companyId, reportDefinitionId: v.reportDefinitionId,
    nameEn: v.nameEn, nameAr: v.nameAr, parameters: v.parameters,
    ownerPrincipalId: v.ownerPrincipalId, shared: v.shared,
    archivedAt: v.archivedAt, createdAt: v.createdAt,
  };
}

savedViewRoutes.openapi(createRoute({
  method: "get", path: "/", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema }), query: SavedViewQuery },
  responses: { 200: { description: "Saved views", content: { "application/json": { schema: SavedViewList } } }, 400: problem(400) },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const q = c.req.valid("query");
  let cursor: { createdAt: string; id: string } | null = null;
  if (q.cursor !== undefined) {
    const decoded = decodeCursor(q.cursor);
    const [createdAt] = decoded.k;
    if (typeof createdAt !== "string") {
      throw new AppError("ERR_VALIDATION_FAILED", "the cursor's keyset does not match this list's sort key");
    }
    cursor = { createdAt, id: decoded.id };
  }
  // The store returns the caller's OWN views plus every `shared` one, newest first; it needs no
  // principal argument because `app.current_actor()` inside the transaction already is the caller.
  const rows = await c.var.withTenant((tx) => listSavedViews(tx, {
    companyId, reportDefinitionId: q["filter[report_definition_id][eq]"], limit: q.limit, cursor,
  }));
  const last = rows[rows.length - 1];
  return c.json({
    items: rows.map(toDto),
    next_cursor: rows.length === q.limit && last !== undefined
      ? encodeCursor({ k: [last.createdAt], id: last.id })
      : null,
  }, 200);
});

savedViewRoutes.openapi(createRoute({
  method: "post", path: "/", tags: ["reports"],
  request: {
    params: z.object({ companyId: UuidSchema }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: CreateSavedViewBody } } },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: SavedViewSchema } } },
    400: problem(400), 404: problem(404),
  },
}), async (c) => {
  const { companyId } = c.req.valid("param");
  const body = c.req.valid("json");
  // `ownerPrincipalId` is never taken from the payload: the column defaults to `app.current_actor()`
  // (Task 2), so a caller cannot save a bookmark into someone else's list.
  const row = await c.var.withTenant((tx) => createSavedView(tx, {
    companyId, reportDefinitionId: body.reportDefinitionId, nameEn: body.nameEn,
    nameAr: body.nameAr ?? null, parameters: body.parameters, shared: body.shared,
  }));
  return c.json(toDto(row), 201);
});

savedViewRoutes.openapi(createRoute({
  method: "get", path: "/{viewId}", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema, viewId: UuidSchema }) },
  responses: { 200: { description: "The view", content: { "application/json": { schema: SavedViewSchema } } }, 403: problem(403), 404: problem(404) },
}), async (c) => {
  const { companyId, viewId } = c.req.valid("param");
  const row = await c.var.withTenant((tx) => getSavedView(tx, viewId));
  if (row === null || row.companyId !== companyId || row.archivedAt !== null) {
    throw new AppError("ERR_NOT_FOUND", `saved view ${viewId} was not found`);
  }
  // Reading someone else's PRIVATE view is a refusal, not a 404: the row is inside the caller's own
  // tenant and company, so pretending it does not exist would hide a real permission decision. A row in
  // another TENANT is invisible to RLS and takes the 404 branch above, which is what the isolation probe
  // asserts.
  if (!row.shared && row.ownerPrincipalId !== c.var.ctx.actorId) {
    throw new AppError("ERR_RBAC_FORBIDDEN", `saved view ${viewId} belongs to another user and is not shared`);
  }
  return c.json(toDto(row), 200);
});

savedViewRoutes.openapi(createRoute({
  method: "put", path: "/{viewId}", tags: ["reports"],
  request: {
    params: z.object({ companyId: UuidSchema, viewId: UuidSchema }),
    headers: IdempotencyHeader,
    body: { content: { "application/json": { schema: UpdateSavedViewBody } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: SavedViewSchema } } },
    400: problem(400), 403: problem(403), 404: problem(404),
  },
}), async (c) => {
  const { companyId, viewId } = c.req.valid("param");
  const body = c.req.valid("json");
  const existing = await c.var.withTenant((tx) => getSavedView(tx, viewId));
  if (existing === null || existing.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `saved view ${viewId} was not found`);
  }
  // `updateSavedView` calls `assertOwner` itself and raises ERR_RBAC_FORBIDDEN; the pre-flight exists
  // only to separate "another company's id in the path" from "not yours", which the store cannot see.
  const row = await c.var.withTenant((tx) => updateSavedView(tx, { id: viewId, ...body }));
  return c.json(toDto(row), 200);
});

savedViewRoutes.openapi(createRoute({
  method: "delete", path: "/{viewId}", tags: ["reports"],
  request: { params: z.object({ companyId: UuidSchema, viewId: UuidSchema }), headers: IdempotencyHeader },
  responses: { 204: { description: "Archived" }, 403: problem(403), 404: problem(404) },
}), async (c) => {
  const { companyId, viewId } = c.req.valid("param");
  const existing = await c.var.withTenant((tx) => getSavedView(tx, viewId));
  if (existing === null || existing.companyId !== companyId) {
    throw new AppError("ERR_NOT_FOUND", `saved view ${viewId} was not found`);
  }
  // Archived, never deleted (spec:2049): `app_rw` holds no DELETE on `saved_view` and the pinned
  // five-row DELETE list of Task 2 is what proves it. A second DELETE of an already-archived view is a
  // no-op that still answers 204, which is what makes the route idempotent in fact and not just by header.
  await c.var.withTenant((tx) => archiveSavedView(tx, viewId));
  return c.body(null, 204);
});

export const savedViewRouteModule: RouteModule = {
  path: "/v1/companies/:companyId/saved-views",
  router: savedViewRoutes,
  // EMPTY, and deliberately so. A saved view is personal state — a named parameter set its owner bookmarks —
  // and §3.6.1 closes the permission vocabulary with no code for it (spec:2146-2150 name none). The gates are
  // RLS (tenant), the company predicate, `owner_principal_id = app.current_actor()` in the store, and the
  // `shared` flag for reading. spec:106 asks every endpoint for a Zod schema, an OpenAPI entry, idempotency on
  // unsafe methods and a tenant-isolation test — all four are present. Inventing a code would breach §3.6.1.
  //
  // `assertRouteGates` (0B) admits this: it checks only routes that HAVE a gate, so an ungated unsafe route
  // passes the boot check. A gate here would have to be a `mutating: false` code, which is exactly what that
  // function rejects with ERR_ROUTE_GATE_READONLY.
  permissions: [],
  auth: "human",
};

export { savedViewRoutes };
```

Three details are load-bearing and easy to get wrong:

- **`DELETE` sets `archived_at` and answers 204** — §4.11.2 says so literally, and `app_rw` has no `DELETE`
  privilege on the table, so a handler that tried a real delete would fail at the database with a
  permission error mapped to `ERR_INTERNAL` rather than doing the wrong thing quietly.
- **`GET /{viewId}` is the one place a 403 is right**, and only for a row in the caller's own tenant and
  company. Every cross-tenant read is a 404 because RLS removed the row before the handler ran — the
  distinction the isolation probe in Step 8 asserts.
- **`c.var.ctx.actorId`, not a body field or a header**, is who the caller is (§4.2.3). The store's
  `assertOwner` compares against `app.current_actor()` in SQL and is the authority; the handler's check
  exists to give a readable message before a round trip.

- [ ] **Step 7: Write the DoD route test**

`apps/api/test/routes/accounting/report-definitions.test.ts` — the clause is one `it`, and it is the whole point of Phase 7A:

```ts
  it("A USER CLONES AND EDITS A REPORT WITHOUT A RELEASE — the Phase 7 DoD clause (spec:2293)", async () => {
    // 1. a core definition, as the seed pack would have applied it
    const core = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-definitions?filter[code][eq]=accounting.trial_balance`, as: s.human });
    const coreRow = (await core.json() as { items: { id: string; version: number; isCore: boolean; definition: { columns: unknown[] } }[] }).items[0]!;
    expect(coreRow.isCore).toBe(true);
    const coreBefore = JSON.stringify(coreRow.definition);

    // 2. clone it — no release, no migration, no deploy
    const cloned = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/report-definitions/${coreRow.id}/clone`,
      body: { overrides: { nameEn: "My trial balance", nameAr: "ميزاني" } }, as: s.human,
    });
    expect(cloned.status).toBe(201);
    const clone = await cloned.json() as { id: string; version: number; isCore: boolean; clonedFrom: string; definition: Record<string, unknown> };
    expect(clone.version).toBe(coreRow.version + 1);
    expect(clone.isCore).toBe(false);
    expect(clone.clonedFrom).toBe(coreRow.id);

    // 3. EDIT the clone — drop a column, add a group, add a total
    const edited = await api.request({
      method: "PUT", path: `/v1/companies/${s.company}/report-definitions/${clone.id}`,
      body: {
        definition: {
          ...clone.definition,
          columns: [
            { field: "account_type", labelEn: "Type", labelAr: "النوع", format: "text", align: "start" },
            { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
          ],
          groups: [{ field: "account_type", subtotal: true }],
          totals: [{ field: "base_debit", fn: "sum" }],
          sort: [{ field: "account_type", dir: "asc" }],
        },
      },
      as: s.human,
    });
    expect(edited.status).toBe(200);

    // 4. RUN the edited clone: a plain run resolves {code} to the highest version, which is the clone
    const run = await api.request({
      method: "POST", path: `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`,
      body: { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" }, as: s.human,
    });
    expect(run.status).toBe(202);
    const runId = (await run.json() as { runId: string }).runId;
    const runRow = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-runs/${runId}`, as: s.human });
    expect((await runRow.json() as { reportDefinitionId: string }).reportDefinitionId).toBe(clone.id);

    // 5. the core row is byte-unchanged, and refuses an in-place edit
    const after = await api.request({ method: "GET", path: `/v1/companies/${s.company}/report-definitions/${coreRow.id}`, as: s.human });
    expect(JSON.stringify((await after.json() as { definition: unknown }).definition)).toBe(coreBefore);
    const refused = await problemOf(await api.request({
      method: "PUT", path: `/v1/companies/${s.company}/report-definitions/${coreRow.id}`,
      body: { definition: { ...coreRow.definition, nameEn: "No" } }, as: s.human,
    }));
    expect(refused.code).toBe("ERR_VALIDATION_FAILED");
    expect(refused.detail).toContain("is a core definition; clone it");
  });
```

The file's head and its four remaining `it`s:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { grantCodes, seedReportDefinition, seedTenantV2, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/** The core `accounting.trial_balance` definition, as the seed pack applies it (Task 14). */
const CORE = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: { source: "account_balance", filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }] },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
    { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
  ],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("/v1/companies/{companyId}/report-definitions", () => {
  let api: StartedApi;
  let s: Seed;
  let definitionId: string;
  let reader: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "defs-api");
    definitionId = await seedReportDefinition(api.db, s, {
      code: "accounting.trial_balance", definition: CORE, isCore: true,
    });
    await grantCodes(api.db, s, {
      codes: ["admin.company.manage", "accounting.report.read", "accounting.report.export"],
    });
    // A second human who may READ reports but may not MANAGE definitions - the 403 case below. The
    // principal rows go in through `db.admin` because `app.principal` carries no tenant_id and
    // `seedTenantV2` mints exactly one human (§4.1, pinned); `grantCodes` then gives it the narrow code.
    reader = await api.db.admin`select uuidv7() as id`.then((r) => (r[0] as { id: string }).id);
    await api.db.admin`insert into app.principal (id, kind, auth_subject, display_name)
                       values (${reader}, 'human', ${`sub:${reader}`}, 'Reader')`;
    await api.db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${reader})`;
    await grantCodes(api.db, s, {
      codes: ["accounting.report.read"], principalId: reader, roleCode: "READER",
    });
    await api.loadPrincipals();
  });
  afterAll(async () => { await api.stop(); });

  const path = (suffix = "") => `/v1/companies/${s.company}/report-definitions${suffix}`;
```

(the DoD `it` above goes here, then:)

```ts
  it("a reader may LIST and GET but not create, clone, edit or archive - admin.company.manage gates the writes", async () => {
    // Reads: membership is the only gate, so the narrow reader sees the catalogue.
    expect((await api.request({ method: "GET", path: path(), as: reader })).status).toBe(200);
    expect((await api.request({ method: "GET", path: path(`/${definitionId}`), as: reader })).status).toBe(200);

    // Writes: all four are gated by `admin.company.manage`, which the reader does not hold (§3.6.1 names no
    // report-authoring code, so the definition catalogue is company configuration - ADR 0067).
    const denials = await Promise.all([
      api.request({ method: "POST", path: path(), body: { definition: { ...CORE, code: "accounting.my_report" } }, as: reader }),
      api.request({ method: "POST", path: path(`/${definitionId}/clone`), body: { overrides: { nameEn: "Mine", nameAr: "لي" } }, as: reader }),
      api.request({ method: "PUT", path: path(`/${definitionId}`), body: { definition: CORE }, as: reader }),
      api.request({ method: "POST", path: path(`/${definitionId}/archive`), as: reader }),
    ]);
    for (const res of denials) {
      expect(res.status).toBe(403);
      expect((await res.json() as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
    }
  });

  it("an invalid definition is ERR_VALIDATION_FAILED with a JSON-Pointer for every fault", async () => {
    const bad = await problemOf(await api.request({
      method: "POST", path: path(), as: s.human,
      body: {
        definition: {
          ...CORE, code: "accounting.bad_report",
          nameAr: "",                                            // minLength 1 - LEGACY-085's guard
          dataset: { source: "not_a_dataset", filters: [] },     // outside the closed DatasetId registry
          // `columns[0].field` is deliberately NOT asserted on here: `validateReportDefinition` takes the
          // dataset IDS and the permission codes as its two sets (§4.11.1) and cannot see a dataset's
          // column list, and with `source` unknown nothing downstream could look one up either. The
          // next `it` proves where a bad field IS caught.
          columns: [{ field: "account_code", labelEn: "N", labelAr: "لا", format: "text", align: "start" }],
        },
      },
    }));
    expect(bad.code).toBe("ERR_VALIDATION_FAILED");
    // §4.2.4 lets ERR_VALIDATION_FAILED carry `errors[]`; the pointers come from Ajv (`/nameAr`) and from
    // validateReportDefinition's closed-set check (`/dataset/source`), which is why both faults are
    // reported at once rather than one per round trip.
    const pointers = (bad as Problem & { errors?: { pointer: string; detail: string }[] }).errors ?? [];
    expect(pointers.map((e) => e.pointer)).toEqual(
      expect.arrayContaining(["/nameAr", "/dataset/source"]));
    expect(pointers.find((e) => e.pointer === "/dataset/source")!.detail).toContain("not_a_dataset");
  });

  it("a column, group, total or sort field the dataset does not have is refused at SAVE time", async () => {
    const bad = await problemOf(await api.request({
      method: "POST", path: path(), as: s.human,
      body: {
        definition: {
          ...CORE, code: "accounting.typo_report",
          columns: [{ field: "acount_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
        },
      },
    }));
    // This one is `packages/db`'s check, not the JSON Schema's and not `validateReportDefinition`'s: only
    // the `packages/db` tier can see `datasetFor(source).columns`, so `assertValid` in the definition store
    // is where it lives (Step 4). Without it a typo'd display column renders as a silently EMPTY column -
    // the worst failure mode a financial report has, because the total still adds up.
    expect(bad.code).toBe("ERR_VALIDATION_FAILED");
    expect(bad.detail).toContain("acount_code");
    expect(bad.detail).toContain("account_balance");
  });

  it("an archived definition disappears from the list, still GETs by id, and refuses a run", async () => {
    const created = await api.request({
      method: "POST", path: path(), as: s.human,
      body: { definition: { ...CORE, code: "accounting.scratch_report", nameEn: "Scratch" } },
    });
    expect(created.status).toBe(201);
    const scratch = await created.json() as { id: string };

    expect((await api.request({ method: "POST", path: path(`/${scratch.id}/archive`), as: s.human })).status).toBe(204);

    const listed = await api.request({ method: "GET", path: path("?filter[code][eq]=accounting.scratch_report"), as: s.human });
    expect((await listed.json() as { items: unknown[] }).items).toEqual([]);
    // Archived, never deleted (spec:2049): the row is still addressable, which is what keeps an old
    // report_run's `report_definition_id` FK resolvable and its download reproducible.
    const still = await api.request({ method: "GET", path: path(`/${scratch.id}`), as: s.human });
    expect(still.status).toBe(200);
    expect((await still.json() as { archivedAt: string | null }).archivedAt).not.toBeNull();

    const refused = await problemOf(await api.request({
      method: "POST", path: `/v1/companies/${s.company}/reports/accounting.scratch_report/runs`,
      body: { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" }, as: s.human,
    }));
    expect(refused.code).toBe("ERR_NOT_FOUND");
    expect(refused.detail).toContain("accounting.scratch_report");
  });

  it("all four unsafe routes require Idempotency-Key", async () => {
    const cases: { method: "POST" | "PUT"; path: string; body?: unknown }[] = [
      { method: "POST", path: path(), body: { definition: { ...CORE, code: "accounting.k_report" } } },
      { method: "POST", path: path(`/${definitionId}/clone`), body: { overrides: { nameEn: "K", nameAr: "ك" } } },
      { method: "PUT", path: path(`/${definitionId}`), body: { definition: CORE } },
      { method: "POST", path: path(`/${definitionId}/archive`) },
    ];
    for (const c of cases) {
      const res = await api.request({ ...c, as: s.human, idempotencyKey: null });
      expect((await res.json() as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });
});
```

`apps/api/test/routes/accounting/saved-views.test.ts` — the store test's scenarios, through HTTP, on the module that carries **no** permission gate at all:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { grantCodes, seedReportDefinition, seedTenantV2, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const DEF = {
  version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
  module: "accounting", permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: { source: "account_balance", filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("/v1/companies/{companyId}/saved-views", () => {
  let api: StartedApi;
  let s: Seed;
  let definitionId: string;
  let colleague: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "views-api");
    definitionId = await seedReportDefinition(api.db, s, { code: "accounting.trial_balance", definition: DEF });
    colleague = await api.db.admin`select uuidv7() as id`.then((r) => (r[0] as { id: string }).id);
    await api.db.admin`insert into app.principal (id, kind, auth_subject, display_name)
                       values (${colleague}, 'human', ${`sub:${colleague}`}, 'Colleague')`;
    await api.db.admin`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${colleague})`;
    // NEITHER principal is granted a permission code: this module declares `permissions: []`, so membership
    // plus the company predicate plus the owner column are the whole of the authorisation. An `it` that
    // needed `grantCodes` here would be evidence the gate had moved, which is why none of them calls it.
    await api.loadPrincipals();
  });
  afterAll(async () => { await api.stop(); });

  const path = (suffix = "") => `/v1/companies/${s.company}/saved-views${suffix}`;
  const create = (as: string, body: Record<string, unknown>) =>
    api.request({ method: "POST", path: path(), body: { reportDefinitionId: definitionId, ...body }, as });

  it("creates a view owned by the caller, with no permission code involved", async () => {
    const res = await create(s.human, { nameEn: "Q1", nameAr: "الربع الأول", parameters: { fiscalPeriodId: s.period } });
    expect(res.status).toBe(201);
    const view = await res.json() as { id: string; ownerPrincipalId: string; shared: boolean; archivedAt: string | null };
    expect(view.ownerPrincipalId).toBe(s.human);   // from app.current_actor(), never from the payload
    expect(view.shared).toBe(false);
    expect(view.archivedAt).toBeNull();
  });

  it("refuses a parameter the definition does not declare, at SAVE time", async () => {
    const bad = await problemOf(await create(s.human, {
      nameEn: "Wrong", parameters: { fiscalPeriodId: s.period, branchId: s.hq },
    }));
    expect(bad.code).toBe("ERR_VALIDATION_FAILED");
    expect(bad.detail).toContain("branchId");
  });

  it("a list shows the caller's own views and every shared one, and never a colleague's private view", async () => {
    const mine = await (await create(s.human, { nameEn: "Mine", parameters: {} })).json() as { id: string };
    const theirPrivate = await (await create(colleague, { nameEn: "Theirs", parameters: {} })).json() as { id: string };
    const theirShared = await (await create(colleague, { nameEn: "Shared", parameters: {}, shared: true })).json() as { id: string };

    const ids = (await (await api.request({ method: "GET", path: path(), as: s.human })).json() as { items: { id: string }[] })
      .items.map((v) => v.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(theirShared.id);
    expect(ids).not.toContain(theirPrivate.id);

    // And a direct GET of the private one is a 403, not a 404: the row IS in this caller's tenant and
    // company, so hiding its existence would misreport a permission decision as absence. Only a
    // cross-tenant read answers 404, which is what the isolation probe asserts.
    const denied = await problemOf(await api.request({ method: "GET", path: path(`/${theirPrivate.id}`), as: s.human }));
    expect(denied.code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("the owner may update; a colleague may not, and gets 403 from the STORE", async () => {
    const view = await (await create(s.human, { nameEn: "Before", parameters: {} })).json() as { id: string };

    const ok = await api.request({
      method: "PUT", path: path(`/${view.id}`), body: { nameEn: "After", shared: true }, as: s.human,
    });
    expect(ok.status).toBe(200);
    const updated = await ok.json() as { nameEn: string; shared: boolean };
    expect(updated.nameEn).toBe("After");
    expect(updated.shared).toBe(true);

    // Shared makes it READABLE, never WRITABLE - assertOwner compares app.current_actor() in SQL.
    const refused = await problemOf(await api.request({
      method: "PUT", path: path(`/${view.id}`), body: { nameEn: "Hijacked" }, as: colleague,
    }));
    expect(refused.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(refused.detail).toContain("only its owner may change a saved view");
  });

  it("DELETE archives and answers 204; the row survives and a second DELETE is still 204", async () => {
    const view = await (await create(s.human, { nameEn: "Doomed", parameters: {} })).json() as { id: string };

    expect((await api.request({ method: "DELETE", path: path(`/${view.id}`), as: s.human })).status).toBe(204);

    // The ROW is still there with archived_at set - spec:2049, and `app_rw` holds no DELETE on the table
    // (the five-row DELETE list Task 2 re-asserts). The resource is gone from the list and from GET.
    const [row] = await api.db.admin<{ archived_at: string | null }[]>`
      select archived_at from app.saved_view where id = ${view.id}`;
    expect(row!.archived_at).not.toBeNull();
    expect((await api.request({ method: "GET", path: path(`/${view.id}`), as: s.human })).status).toBe(404);
    expect((await api.request({ method: "DELETE", path: path(`/${view.id}`), as: s.human })).status).toBe(204);
  });

  it("every unsafe route requires Idempotency-Key", async () => {
    const view = await (await create(s.human, { nameEn: "Keys", parameters: {} })).json() as { id: string };
    const cases: { method: "POST" | "PUT" | "DELETE"; path: string; body?: unknown }[] = [
      { method: "POST", path: path(), body: { reportDefinitionId: definitionId, nameEn: "K" } },
      { method: "PUT", path: path(`/${view.id}`), body: { nameEn: "K" } },
      { method: "DELETE", path: path(`/${view.id}`) },
    ];
    for (const c of cases) {
      const res = await api.request({ ...c, as: s.human, idempotencyKey: null });
      expect((await res.json() as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    }
  });
});
```

**`grantCodes`' `roleCode` option matters in the definitions file.** §4.17 gives it `{ codes?; principalId?; roleCode?; branchIds? }`, and two calls in one `beforeAll` without distinct `roleCode`s would collide on `app.role`'s `(tenant_id, code)` uniqueness — the second call would either fail or silently widen the first principal's role. `"READER"` is passed for exactly that reason.

- [ ] **Step 8: Register both modules, add both probes, run everything**

In `apps/api/src/routes/index.ts`, inside `buildRoutes`: `reportDefinitionRouteModule` and `savedViewRouteModule`. In `tests/invariants/probes.ts`, one entry each, keyed by the exact module path. **Both expect 404, and the reason is the same for both:** RLS hides the other tenant's row, so `getReportDefinition` / `getSavedView` return `null` and the handler raises `ERR_NOT_FOUND` — `assertOwner` never runs, because there is no row to check. An entry expecting **403** for `saved-views` would be wrong for exactly that reason: an owner refusal is only reachable for a row the caller can already see, which a cross-tenant probe never can. (`report-runs` in Task 12 is the one entry that expects 403, because `requireReportExport(c, companyId)` runs on the **path parameter** before any row is read.)

Run: `bun run --cwd apps/api test -- routes/accounting/report-definitions routes/accounting/saved-views && bun run --cwd tests test -- tenant-isolation && bun run --cwd packages/contracts openapi:generate && bun run lint:rules && bun run typecheck && bun run test`
Expected: PASS throughout, including the DoD `it`. Commit the regenerated `packages/contracts/openapi.json`.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/reports/definition-store.ts packages/db/src/reports/saved-view-store.ts \
        packages/db/src/reports/index.ts packages/db/test/reports/definition-store.test.ts \
        packages/db/test/reports/saved-view-store.test.ts \
        packages/contracts/src/accounting/report-definition.ts packages/contracts/src/accounting/saved-view.ts \
        packages/contracts/src/index.ts packages/contracts/openapi.json \
        apps/api/src/routes/accounting/report-definitions.ts apps/api/src/routes/accounting/saved-views.ts \
        apps/api/src/routes/index.ts apps/api/test/routes/accounting/report-definitions.test.ts \
        apps/api/test/routes/accounting/saved-views.test.ts tests/invariants/probes.ts
git commit -m "$(cat <<'EOF'
feat(api): clone and edit a report without a release; saved views [7A T13]

The Phase 7 DoD clause, proved end to end: clone a core definition, edit the
clone, run it, and the core row is byte-unchanged. A clone takes max(version)+1
so 7B's version-2 upsert cannot overwrite it; a core row refuses an in-place
edit, because the seed pack re-applies it on every deploy. Definition writes are
gated by admin.company.manage (§3.6.2's class for configuration); reads by
membership, following §4.2.11. A saved view carries NO permission code — §3.6.1
closes the vocabulary and names none — and is gated by RLS, ownership in the
store, and the shared flag. DELETE archives and returns 204.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: The `reports` sub-pack loader and the three regression files

§3.4.8 assigns the **`reports` sub-pack loader** to this slice: "0C builds the CLI, the flag and the `chart-of-accounts` and `fiscal-periods` loaders; 1A ships the `document-types` loader …; 2C `templates`, 5A `tax`, **7A `reports`**, 8A `statutory`." And **7A itself seeds no definition** (§2.8's card): the loader is the seam 7B, 7C and 8D pour their directories into.

**Files:**
- Create: `packages/db/src/seed/reports.ts`, `packages/db/seed/my/reports/README.md`, `packages/db/test/seed/reports.test.ts`, `tests/regression/legacy-077.test.ts`
- Modify: `packages/db/src/seed/types.ts`, `packages/db/src/seed/packs.ts`, `packages/db/src/seed/index.ts`, `packages/db/test/seed-packs.test.ts`, `tests/regression/legacy-069.test.ts`, `tests/regression/legacy-085.test.ts`

**Interfaces:**
- Consumes: `PackLoader`, `LoaderContext`, `readPackFile`, `assertPackShape`, `PHASE_0_SUB_PACK_DIRECTORIES`, `OWNED_ELSEWHERE` from `packages/db/src/seed/packs.ts`; `SubPack`, `SUB_PACKS` from `packages/db/src/seed/types.ts`; `LOADERS`, `runLoaders` from `packages/db/src/seed/index.ts` (§4.2.13, 0C, widened by 1A, 2C and 5A); `withTenant`, `TenantContext` (§4.2.2); `reportDefinitionSets` (Task 13); `assertDefinitionFields` (Task 9); `validateReportDefinition`, `parseReportDefinition` (Task 4); `sharedDb`, `thinRegression`, `sourceFiles`, `repoFile`, `REPO_ROOT` (§4.17.1, 0B/0C).
- Produces:

```ts
// packages/db/src/seed/reports.ts — exported from packages/db/src/seed/index.ts, reached as @dulja/db/seed
export interface ReportSeedResult { applied: number; codes: readonly string[] }
/** §4.16.1's seed-file envelope. `definitionVersion` is `app.report_definition.version` (the ROW version, the
 *  one §4.16.1 requires a re-expressed code to raise to 2); `definition.version` is §4.11.1's FORMAT version,
 *  pinned to 1 by the JSON Schema. Two versions, two names — see the §4.3.7 document-type precedent. */
export interface ReportSeedEnvelope { definitionVersion: number; definition: unknown }
/** The file-reading half: opens its OWN tenant transaction. The CLI and this slice's tests call it. */
export async function loadReportDefinitions(
  sql: Sql, ctx: TenantContext, packDir: string, companyId: string,
): Promise<ReportSeedResult>;
/** The `--only reports` member. `runLoaders` already opened one `withTenant` and hands the resulting `tx`
 *  in, so this form must NOT open another — a nested call raises `ERR_TENANT_CONTEXT_NESTED` (§4.2.2). */
export const reportsLoader: PackLoader;                     // name: "reports"
```

- [ ] **Step 1: Write the failing test**

`packages/db/test/seed/reports.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReportDefinitions, reportsLoader } from "../../src/seed/reports";
import { SUB_PACKS } from "../../src/seed/types";
import { OWNED_ELSEWHERE, PHASE_0_SUB_PACK_DIRECTORIES } from "../../src/seed/packs";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DEF = (code: string) => ({
  version: 1, code, nameEn: `Report ${code}`, nameAr: `تقرير ${code}`,
  module: code.split(".")[0], permission: "accounting.report.read", parameters: [],
  dataset: { source: "account_balance", filters: [] },
  columns: [{ field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
  groups: [], totals: [], sort: [], layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
});

/** §4.16.1's envelope. `definitionVersion` is the ROW version; `definition.version` stays the format's 1. */
const FILE = (code: string, definitionVersion = 1, overrides: Record<string, unknown> = {}) =>
  ({ definitionVersion, definition: { ...DEF(code), ...overrides } });

async function pack(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dulja-reports-pack-"));
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, "reports", relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(body, null, 2), "utf8");
  }
  return root;
}

describe("the reports sub-pack loader — contracts §3.4.8, §4.2.13", () => {
  let db: Db;
  let s: Seed;

  beforeAll(async () => { db = await startDb(); s = await seedTenantV2(db, "reports-loader"); });
  afterAll(async () => { await db.stop(); });

  const ctx = () => ({ tenantId: s.tenant, actorId: s.system, requestId: crypto.randomUUID() });

  it("registers the sub-pack: SUB_PACKS gains 'reports' LAST, the directory joins the required list, and OWNED_ELSEWHERE loses it", () => {
    expect(SUB_PACKS).toContain("reports");
    // Application order, never alphabetical (§4.2.13): a definition is validated against the datasets and the
    // permission catalogue, and the permission rows arrive with the migrations — so reports go last.
    expect(SUB_PACKS[SUB_PACKS.length - 1]).toBe("reports");
    expect(PHASE_0_SUB_PACK_DIRECTORIES).toContain("reports");
    expect(Object.keys(OWNED_ELSEWHERE)).not.toContain("reports");
    expect(Object.keys(OWNED_ELSEWHERE)).toContain("statutory");     // 8A's, still owned elsewhere
  });

  it("loads every <slice>/<code>.json, keyed by the file name, and reports the codes", async () => {
    const root = await pack({
      "7b/accounting.general_ledger.json": FILE("accounting.general_ledger"),
      "7b/inventory.movement_register.json": FILE("inventory.movement_register"),
      "7c/accounting.party_statement.json": FILE("accounting.party_statement"),
    });
    const result = await loadReportDefinitions(db.rw, ctx(), root, s.company);
    expect(result.applied).toBe(3);
    expect([...result.codes]).toEqual([
      "accounting.general_ledger", "accounting.party_statement", "inventory.movement_register",
    ]);
    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ code: string; version: number; is_core: boolean }[]>`
        select code, version, is_core from app.report_definition order by code`);
    expect(rows.every((r) => r.is_core)).toBe(true);
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });

  it("is idempotent: re-running the same file replaces the row rather than duplicating it (§3.4.8)", async () => {
    const root = await pack({ "7b/accounting.audit_log.json": FILE("accounting.audit_log") });
    await loadReportDefinitions(db.rw, ctx(), root, s.company);
    const again = await loadReportDefinitions(db.rw, ctx(), root, s.company);
    expect(again.applied).toBe(1);       // re-applied, not duplicated

    const edited = await pack({
      "7b/accounting.audit_log.json": FILE("accounting.audit_log", 1, { nameEn: "Audit log corrected" }),
    });
    await loadReportDefinitions(db.rw, ctx(), edited, s.company);
    const [row] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ n: number; name: string }[]>`
        select count(*)::int as n, max(definition->>'nameEn') as name
          from app.report_definition where code = 'accounting.audit_log'`);
    expect(row!.n).toBe(1);
    expect(row!.name).toBe("Audit log corrected");
  });

  it("seeds a RE-EXPRESSED code at definitionVersion 2 beside version 1 — §4.16.1's rule for 7B and 7C", async () => {
    // The envelope carries the ROW version. `definition.version` is the FORMAT version and the schema pins it
    // to `"const": 1`, so a loader that wrote it into the column could never seed a version-2 row at all —
    // and every re-expressed code (7B's five, 7C's two) would be unshippable.
    const v1 = await pack({ "7b/accounting.trial_balance.json": FILE("accounting.trial_balance", 1) });
    await loadReportDefinitions(db.rw, ctx(), v1, s.company);
    const v2 = await pack({
      "7b/accounting.trial_balance.json": FILE("accounting.trial_balance", 2, { nameEn: "Trial balance (7B)" }),
    });
    await loadReportDefinitions(db.rw, ctx(), v2, s.company);

    const rows = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ version: number; name: string }[]>`
        select version, definition->>'nameEn' as name
          from app.report_definition where code = 'accounting.trial_balance' order by version`);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1]!.name).toBe("Trial balance (7B)");
    // The format version never moved with it.
    const [format] = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      tx<{ v: string }[]>`select definition->>'version' as v from app.report_definition
                           where code = 'accounting.trial_balance' and version = 2`);
    expect(format!.v).toBe("1");
  });

  it("refuses a body that is not the envelope, and a definitionVersion below 1 or non-integer", async () => {
    const bare = await pack({ "7b/accounting.ledger.json": DEF("accounting.ledger") });   // no envelope at all
    await expect(loadReportDefinitions(db.rw, ctx(), bare, s.company))
      .rejects.toThrowError(/must be exactly \{ "definitionVersion"/);

    for (const bad of [0, -1, 1.5, "2", null]) {
      const root = await pack({
        "7b/accounting.ledger.json": { definitionVersion: bad, definition: DEF("accounting.ledger") },
      });
      await expect(loadReportDefinitions(db.rw, ctx(), root, s.company), String(bad))
        .rejects.toThrowError(/it must be an integer of at least 1/);
    }
  });

  it("refuses a definition naming a field its dataset does not serve, at SEED time", async () => {
    const typo = await pack({
      "7b/accounting.period_comparison.json": FILE("accounting.period_comparison", 1, {
        columns: [{ field: "acount_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
      }),
    });
    await expect(loadReportDefinitions(db.rw, ctx(), typo, s.company))
      .rejects.toThrowError(/dataset 'account_balance' has no such field: acount_code/);
  });

  it("REFUSES to overwrite a tenant's clone, naming the code and version", async () => {
    const root = await pack({ "7b/accounting.account_statement.json": FILE("accounting.account_statement") });
    await loadReportDefinitions(db.rw, ctx(), root, s.company);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.report_definition set is_core = false where code = 'accounting.account_statement'`;
    });
    await expect(loadReportDefinitions(db.rw, ctx(), root, s.company))
      .rejects.toThrowError(/accounting.account_statement version 1 is a tenant's own definition/);
  });

  it("refuses a definition whose file name disagrees with its code, and one that fails validation", async () => {
    const wrongName = await pack({ "7b/accounting.ledger.json": FILE("accounting.general_ledger") });
    await expect(loadReportDefinitions(db.rw, ctx(), wrongName, s.company))
      .rejects.toThrowError(/file '7b\/accounting.ledger.json' declares code 'accounting.general_ledger'/);

    const invalid = await pack({
      "7b/accounting.ledger.json": FILE("accounting.ledger", 1, { dataset: { source: "invoices", filters: [] } }),
    });
    await expect(loadReportDefinitions(db.rw, ctx(), invalid, s.company))
      .rejects.toThrowError(/\/dataset\/source/);

    const unseededCode = await pack({
      "7b/accounting.ledger.json": FILE("accounting.ledger", 1, { permission: "accounting.report.print" }),
    });
    // F-21: a definition naming a permission code no slice has seeded is refused at SEED time, not at run time.
    await expect(loadReportDefinitions(db.rw, ctx(), unseededCode, s.company))
      .rejects.toThrowError(/\/permission/);
  });

  it("reportsLoader.load runs on a transaction runLoaders already opened, and never nests", async () => {
    const root = await pack({ "7b/inventory.expiry_list.json": FILE("inventory.expiry_list") });
    const applied = await withTenant(db.rw, s.tenant, s.system, (tx) => reportsLoader.load(tx, {
      config: { tenantId: s.tenant, only: ["reports"], packRoot: root } as never,
      tenantId: s.tenant, companyId: s.company, systemPrincipalId: s.system, packRoot: root,
    }));
    expect(applied).toBe(1);
    expect(reportsLoader.name).toBe("reports");
  });

  it("the shipped pack directory exists and contains no definition — 7A seeds none (§2.8)", async () => {
    const { readdir } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(new URL("../../seed/my/reports", import.meta.url));
    const entries = await readdir(dir);
    expect(entries).toContain("README.md");
    expect(entries.filter((e) => e.endsWith(".json"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun run --cwd packages/db test -- seed/reports`
Expected: FAIL — `Failed to resolve import "../../src/seed/reports"`.

- [ ] **Step 3: Write the loader**

`packages/db/src/seed/reports.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "postgres";
import { withTenant, type TenantContext } from "../with-tenant";
import { reportDefinitionSets } from "../reports/definition-store";
import { ReportError } from "../reports/errors";
import { assertDefinitionFields } from "../reports/statement";
import { parseReportDefinition, validateReportDefinition } from "@dulja/domain";
import type { LoaderContext, PackLoader } from "./packs";

export interface ReportSeedResult { applied: number; codes: readonly string[] }

/**
 * **The seed-file envelope**, on 1A's document-type precedent (§4.3.7). A report file is
 * `{ "definitionVersion": <int ≥ 1>, "definition": <ReportDefinition> }` and nothing else.
 *
 * The two numbers are DIFFERENT and must not share a name. `definition.version` is §4.11.1's **format**
 * version, frozen at the JSON Schema's `"const": 1` — a schema change is a new `const` and a new `$id`, never
 * a widened enum. `definitionVersion` is `app.report_definition.version`, the row's tenant-edit version that
 * `unique (company_id, code, version)` keys on, and §4.16.1 requires a re-expressed code to be seeded at
 * `definitionVersion = 2`. Writing `definition.version` into the row column would pin every seeded core row at
 * version 1 forever and make 7B's five re-expressed codes and 7C's two unseedable.
 */
export interface ReportSeedEnvelope { definitionVersion: number; definition: unknown }

interface PackFile { relative: string; body: unknown }

/** `<packRoot>/reports/<owning slice>/<code>.json` — §4.16.1's layout, so 7B, 7C, 8D and the four
 *  minimal-set slices never touch one file. Sorted, so a seed run is deterministic and diffable. */
async function collect(packDir: string): Promise<PackFile[]> {
  const slices = (await readdir(packDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const files: PackFile[] = [];
  for (const slice of slices) {
    const names = (await readdir(join(packDir, slice))).filter((n) => n.endsWith(".json")).sort();
    for (const name of names) {
      const text = await readFile(join(packDir, slice, name), "utf8");
      let body: unknown;
      try { body = JSON.parse(text); }
      catch (e) {
        throw new ReportError(
          "ERR_VALIDATION_FAILED",
          `report seed file '${slice}/${name}' is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      files.push({ relative: `${slice}/${name}`, body });
    }
  }
  return files.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

/**
 * The transaction half. `tx` is already inside ONE tenant transaction — opened by `loadReportDefinitions`
 * below, or by 0C's `runLoaders` before it calls `reportsLoader.load`. It never opens its own; §4.2.2 forbids
 * nesting and would raise `ERR_TENANT_CONTEXT_NESTED`. This is 1A's `document-types` shape exactly.
 */
async function applyReports(tx: Sql, companyId: string, files: readonly PackFile[]): Promise<ReportSeedResult> {
  // Read the two closed sets ONCE per run: the permission catalogue comes from `app.permission` and the
  // dataset ids from `DATASET_IDS`, because `packages/db` may not import `@dulja/contracts` (§3.1).
  const sets = await reportDefinitionSets(tx);
  const codes: string[] = [];

  for (const file of files) {
    // 1. the envelope. Three refusals, exactly the three `loadDocumentTypes` performs (§4.3.7): a body that
    //    is not the two-member envelope, a `definitionVersion` that is not an integer ≥ 1, and a `definition`
    //    that fails validation. `definitionVersion` is the ROW version; `definition.version` is the FORMAT
    //    version and the schema pins it to 1, so reading the row version off it would make every seeded core
    //    row version 1 forever — see `ReportSeedEnvelope`.
    const envelope = file.body as Partial<ReportSeedEnvelope> | null;
    if (
      envelope === null || typeof envelope !== "object" ||
      Object.keys(envelope).sort().join(",") !== "definition,definitionVersion"
    ) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `report seed file '${file.relative}' must be exactly { "definitionVersion": <int ≥ 1>, "definition": … } (§4.16.1's envelope)`,
      );
    }
    const definitionVersion = envelope.definitionVersion;
    if (typeof definitionVersion !== "number" || !Number.isInteger(definitionVersion) || definitionVersion < 1) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `report seed file '${file.relative}' declares definitionVersion ${JSON.stringify(definitionVersion)}; it must be an integer of at least 1`,
      );
    }

    // 2. the definition itself
    const result = validateReportDefinition(envelope.definition, sets);
    if (!result.ok) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `report seed file '${file.relative}' is invalid: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
      );
    }
    const definition = parseReportDefinition(envelope.definition);
    // Every field the definition names must exist on the rows its dataset produces — the same check the
    // definition store runs (Task 9, Task 13), so a pack file and a hand-written definition are held to one
    // rule. Without it a typo'd display column ships to every tenant as a silently empty column.
    assertDefinitionFields(definition);
    const expected = `${definition.code}.json`;
    if (!file.relative.endsWith(`/${expected}`)) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `report seed file '${file.relative}' declares code '${definition.code}'; §4.16.1 requires the file to be named '${expected}' (the ROW version is the envelope's definitionVersion, never part of the file name)`,
      );
    }

    // §3.4.8's policy-version rule applied to reports: a CORE row is `do update`, so a placeholder seeded on
    // staging in an early phase cannot silently survive the real definition arriving later. The `where
    // is_core` clause is what protects a tenant's clone at the same version — and a suppressed update is
    // detected and RAISED rather than passed over, because a silent no-op is how a staging deploy diverges.
    const rows = await tx<{ id: string }[]>`
      insert into app.report_definition
        (tenant_id, company_id, code, version, definition, is_core)
      values (app.current_tenant(), ${companyId}, ${definition.code}, ${definitionVersion},
              ${JSON.stringify(definition)}::jsonb, true)
      on conflict (company_id, code, version) do update
        set definition = excluded.definition, archived_at = null
        where report_definition.is_core
      returning id`;
    if (rows.length === 0) {
      throw new ReportError(
        "ERR_VALIDATION_FAILED",
        `${definition.code} version ${definitionVersion} is a tenant's own definition (is_core = false); the seed refuses to overwrite it — raise definitionVersion in '${file.relative}' or archive the tenant's row`,
      );
    }
    codes.push(definition.code);
  }

  return { applied: codes.length, codes };
}

/** The file-reading form. Opens its own tenant transaction, so the CLI and a test can call it directly. */
export async function loadReportDefinitions(
  sql: Sql, ctx: TenantContext, packRoot: string, companyId: string,
): Promise<ReportSeedResult> {
  const files = await collect(join(packRoot, "reports"));
  return withTenant(sql, ctx, (tx) => applyReports(tx, companyId, files));
}

export const reportsLoader: PackLoader = {
  name: "reports",
  async load(tx, ctx: LoaderContext) {
    const files = await collect(join(ctx.packRoot, "reports"));
    const result = await applyReports(tx, ctx.companyId, files);
    return result.applied;
  },
};
```

- [ ] **Step 4: The five registration edits**

Exactly the five §4.2.13 reserves for a loader-owning slice, and nothing more:

1. `packages/db/src/seed/types.ts` — add `"reports"` to the `SubPack` union and to `SUB_PACKS`, **last**: application order, never alphabetical, because a definition is validated against the permission catalogue and the dataset registry and must be applied after everything it can name.
2. `packages/db/src/seed/index.ts` — `export { loadReportDefinitions, reportsLoader, type ReportSeedResult } from "./reports";` and `"reports": reportsLoader,` in `LOADERS`. **Never in `packages/db/src/index.ts` at any depth** — 0C's `legacy-039` regex catches a deeper path too (§3.1).
3. `packages/db/src/seed/index.ts` — add `reports: 0` to `runLoaders`' `applied` initialiser.
4. `packages/db/src/seed/packs.ts` — add `"reports"` to `PHASE_0_SUB_PACK_DIRECTORIES` (the *required-presence* list, §4.2.13) and **remove** the `reports` row from `OWNED_ELSEWHERE`; `statutory` (8A) stays.
5. `packages/db/test/seed-packs.test.ts` — update the two literal lists to their new state.

`packages/db/seed/my/reports/README.md` — the directory must exist for `assertPackShape`, and git does not track an empty one:

```markdown
# Report definitions (the `reports` sub-pack)

One directory per **owning slice**, one `<code>.json` per report, exactly as contracts §4.16.1 fixes:

    packages/db/seed/my/reports/<owning slice, lowercased>/<code>.json

`1b/`, `3d/`, `4b/`, `6d/` (the minimal set spec:2300 ships from Phase 1 onward), `7b/`, `7c/` and `8d/` are
**disjoint** directories, so no two writers ever touch one file.

## The file is an envelope, and it carries TWO different versions

Every file is exactly:

```json
{ "definitionVersion": 1, "definition": { "version": 1, "code": "…", … } }
```

and nothing else — the same shape a document-type seed file has (§4.3.7).

| Member | What it is | Who changes it |
|---|---|---|
| `definitionVersion` | `app.report_definition.version` — the **row** version the `unique (company_id, code, version)` key uses. An integer of at least 1. | **You.** §4.16.1 requires a definition seeded for a code an earlier slice already served to be seeded at `definitionVersion = 2` — that is how 7B re-expresses `accounting.trial_balance`, `accounting.ledger`, `inventory.stock_on_hand`, `inventory.valuation` and `inventory.sales_by_item`, and how 7C re-expresses `accounting.ageing`, `pos.z_report` and `pos.sales_by_cashier`. |
| `definition.version` | §4.11.1's **format** version. The JSON Schema pins it to `"const": 1`; a schema change is a new `const` **and** a new `$id`, never a widened enum. | Nobody, until the format itself changes. |

The row version is **never** encoded in the file name: the file is named `<code>.json` and the loader refuses
any other name. Two versions of one code are two `definitionVersion` values in the same file across two
commits — the file is the current definition, and the row history is in the table.

A re-run of the seed with an unchanged `definitionVersion` **replaces** that row's `definition` (`on conflict
… do update`), so an edit ships by editing the file; raising `definitionVersion` is for a version that must
coexist with the old one, which is what "re-expresses" means.

**7A ships this directory and the loader, and no definition.** The `accounting.profit_and_loss` and
`accounting.balance_sheet` *layouts* are 7A's (`packages/domain/src/reports/statement.ts`); their
*definitions* are 7B's. Adding a `.json` here from any other slice than the one §4.16.1 names is a review
finding.

Apply the pack with `bun run seed --tenant <tenant_id> --only reports`. Every file is validated against
`packages/domain/report-definition.schema.json`, the closed `DatasetId` registry
(`packages/db/src/reports/datasets.ts`), the live permission catalogue (`app.permission`) and — through
`assertDefinitionFields` — the dataset's own column list, **before** it is inserted; a core row is then
upserted on `(company_id, code, version)` — the §3.4.8 policy-version rule — while a tenant's own clone at the
same version is refused rather than overwritten.
```

- [ ] **Step 5: Write `tests/regression/legacy-077.test.ts` (7A is the plain creator)**

§3.7.3's first corollary makes **9A** a create-if-absent appender (it has no fixed position in execution order) and **7A the plain creator**, so the file exists exactly once whichever runs first:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/source";

describe("LEGACY-077 The call graph is unresolvable, so dead code cannot be identified — 7A", () => {
  // The defect: "report definitions are stored as MEMO blobs in the Reports table inside customer
  // databases, not as files … no static analysis can ever determine whether a procedure is live."
  // spec:1246 puts "Delphi-serialised report files" on the do-NOT-carry-over list; spec:1240 wants the
  // designer "text-defined, diffable, version-controlled". This block is the structural proof.

  it("the report format is a committed JSON Schema with a stable $id, not an opaque blob", () => {
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/domain/report-definition.schema.json"), "utf8"));
    expect(schema.$id).toBe("urn:dulja:report-definition:1");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.version).toEqual({ const: 1 });
    // additionalProperties: false at EVERY level is what makes an escape hatch impossible — without it a
    // `sqlOverride` or a serialised blob could ride along and LEGACY-077 would be back.
    for (const [name, def] of Object.entries<{ additionalProperties?: boolean; type?: string }>(schema.$defs)) {
      if (def.type === "object") expect(def.additionalProperties, name).toBe(false);
    }
  });

  it("every core definition is a version-controlled FILE whose name is its code", () => {
    const root = join(REPO_ROOT, "packages/db/seed/my/reports");
    const slices = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const slice of slices) {
      for (const file of readdirSync(join(root, slice.name)).filter((n) => n.endsWith(".json"))) {
        // §4.16.1's envelope: `{ definitionVersion, definition }`. The ROW version lives in the envelope and
        // never in the file name, so the name is always exactly `<definition.code>.json`.
        const body = JSON.parse(readFileSync(join(root, slice.name, file), "utf8")) as {
          definitionVersion: number; definition: { code: string; version: number };
        };
        expect(Object.keys(body).sort(), `${slice.name}/${file}`).toEqual(["definition", "definitionVersion"]);
        expect(Number.isInteger(body.definitionVersion) && body.definitionVersion >= 1, `${slice.name}/${file}`).toBe(true);
        expect(body.definition.version, `${slice.name}/${file}`).toBe(1);   // the FORMAT version, always 1
        expect(file, `${slice.name}/${file}`).toBe(`${body.definition.code}.json`);
      }
    }
    // 7A ships the directory and the loader and seeds nothing (§2.8); 7B, 7C and 8D fill their own
    // directories. The assertion holds at every phase because the rule is the file NAME, not the count.
    expect(readdirSync(root)).toContain("README.md");
  });

  it("a stored definition is reachable by SQL, so \"which reports exist?\" is a query and not an archaeology project", () => {
    const migration = readFileSync(
      join(REPO_ROOT, "packages/db/migrations/0074_create_report_definition.sql"), "utf8");
    expect(migration).toContain("definition   jsonb not null");
    expect(migration).toContain("code         text not null");
    // `Users.Permissions:MEMO` was the same defect on the authorisation side — "you cannot answer 'who can
    // do X?' in SQL". A jsonb column with a queryable `code` is the direct answer for reports.
    expect(migration).not.toMatch(/\bbytea\b/);
  });
});
```

- [ ] **Step 6: Append the 7A blocks to `legacy-069` and `legacy-085`**

Both files exist — `legacy-069` created by **0B**, `legacy-085` by **0E** — so this slice **appends** a `describe` and never edits an earlier block (§3.7.3). **The appended blocks below need imports the existing files may not already carry**: add `import { readdirSync, readFileSync } from "node:fs"`, `import { join } from "node:path"`, `import { REPO_ROOT } from "../support/source"` and `import { sharedDb } from "../support/regression"` to the top of each file **only where they are missing** — adding an import is not editing an earlier `describe` block, and a duplicate import is a `lint` failure rather than a silent problem.

```ts
// tests/regression/legacy-069.test.ts — appended
describe("LEGACY-069 Every report query is rebuilt, re-parsed and re-planned on each call — 7A", () => {
  // 61 `execute statement` sites; `procSerInventory` appended up to 24 fragments into a varchar(600);
  // ~54 sites interpolated DATE parameters as text. The report engine's answer is a CLOSED registry of
  // named static queries whose column references are literal fragments authored in three files.

  it("no dataset file contains a concatenated or interpolated identifier, an .unsafe(, or a bare sql`", () => {
    for (const file of ["accounting.ts", "ar-ap.ts", "inventory.ts"]) {
      const text = readFileSync(join(REPO_ROOT, `packages/db/src/reports/datasets/${file}`), "utf8");
      expect(text, file).not.toMatch(/\$\{\s*(?:[a-zA-Z_$][\w$]*\s*\+|['"`])/);
      expect(text, file).not.toMatch(/\.unsafe\s*\(/);
      expect(text, file).not.toMatch(/\bsql`/);
    }
  });

  it("a DATE parameter is bound and CAST, never interpolated as text — the ~54-site defect", () => {
    const query = readFileSync(join(REPO_ROOT, "packages/db/src/reports/query.ts"), "utf8");
    expect(query).toContain('case "date": return tx`${value}::date`');
    expect(query).toContain("const DATE = /^\\d{4}-\\d{2}-\\d{2}$/");
    // The TypeScript shape check is what turns a malformed date into ERR_VALIDATION_FAILED naming the field
    // instead of SQLSTATE 22P02 mapped to ERR_INTERNAL.
  });

  it("`like` is a prefix match with the metacharacters neutralised, so no user string becomes a pattern", () => {
    const query = readFileSync(join(REPO_ROOT, "packages/db/src/reports/query.ts"), "utf8");
    expect(query).toContain("value.replace(/([\\\\%_])/g, \"\\\\$1\")");
  });

  it("every column a report filters on is indexed, on the three tables this slice created (LEGACY-070's twin)", async () => {
    const { db } = await sharedDb();
    const indexes = await db.migrator<{ tablename: string; indexdef: string }[]>`
      select tablename, indexdef from pg_indexes
       where schemaname = 'app' and tablename in ('report_definition', 'saved_view', 'report_run')`;
    const defs = indexes.map((i) => i.indexdef).join("\n");
    expect(defs).toMatch(/report_definition_lookup_idx.*company_id, code, version/s);
    expect(defs).toMatch(/report_run_recent_idx.*company_id, created_at/s);
    expect(defs).toMatch(/saved_view_owner_idx.*company_id, owner_principal_id/s);
  });
});
```

```ts
// tests/regression/legacy-085.test.ts — appended
describe("LEGACY-085 The English build was never proofread — 7A", () => {
  // 61 untranslated Arabic strings, 122 empty translations, 452 misspellings; two Arabic DIALOGS reached
  // English users. spec:2061: "Both catalogues must be complete before merge — no empty msgstr, no
  // source-language fallbacks in the other language." A report is a user-facing surface, so it is bound too.

  it("the schema makes a missing Arabic label unrepresentable — nameAr and labelAr are REQUIRED, minLength 1", () => {
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages/domain/report-definition.schema.json"), "utf8"));
    expect(schema.required).toContain("nameAr");
    expect(schema.properties.nameAr).toEqual({ type: "string", minLength: 1 });
    expect(schema.$defs.column.required).toEqual(
      expect.arrayContaining(["labelEn", "labelAr"]));
    expect(schema.$defs.column.properties.labelAr).toEqual({ type: "string", minLength: 1 });
    // A definition with an empty Arabic label cannot be seeded OR created through the API: one validator,
    // one refusal, at both doors. That is the structural version of "no empty msgstr".
  });

  it("every committed report definition carries both languages, and neither falls back to the other", () => {
    const root = join(REPO_ROOT, "packages/db/seed/my/reports");
    for (const slice of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      for (const file of readdirSync(join(root, slice.name)).filter((n) => n.endsWith(".json"))) {
        const body = JSON.parse(readFileSync(join(root, slice.name, file), "utf8")) as {
          nameEn: string; nameAr: string; columns: { labelEn: string; labelAr: string }[];
        };
        const where = `${slice.name}/${file}`;
        expect(body.nameAr.trim(), where).not.toBe("");
        expect(body.nameAr, where).not.toBe(body.nameEn);      // no source-language fallback
        expect(body.nameEn, where).toBe(body.nameEn.trim());   // no trailing whitespace (232 occurrences)
        for (const column of body.columns) {
          expect(column.labelAr.trim(), `${where} ${column.labelEn}`).not.toBe("");
          expect(column.labelAr, `${where} ${column.labelEn}`).not.toBe(column.labelEn);
        }
      }
    }
  });

  it("the renderer picks the Arabic label for lang ar and never falls back to the English one", async () => {
    const { intlFormatters, renderReport } = await import("@dulja/domain");
    const definition = JSON.parse(readFileSync(
      join(REPO_ROOT, "packages/domain/test/reports/fixture/statement-rows.json"), "utf8")) as unknown;
    void definition;   // the fixture is rows; the definition below is the minimal one this assertion needs
    const report = renderReport({
      version: 1, code: "accounting.trial_balance", nameEn: "Trial balance", nameAr: "ميزان المراجعة",
      module: "accounting", permission: "accounting.report.read", parameters: [],
      dataset: { source: "account_balance", filters: [] },
      columns: [{ field: "c", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" }],
      groups: [], totals: [], sort: [],
      layout: { orientation: "portrait", paper: "A4", header: "", footer: "" }, tieOut: { kind: "none" },
    }, [{ c: "1000" }], { format: "csv", lang: "ar", formatters: intlFormatters("ar") });
    expect(report.title).toBe("ميزان المراجعة");
    expect(report.columns[0]!.label).toBe("الرمز");
    expect(report.dir).toBe("rtl");
  });
});
```

- [ ] **Step 7: Run everything to see it pass**

Run: `bun run --cwd packages/db test -- seed/reports seed-packs && bun run --cwd tests test -- regression/legacy-077 regression/legacy-069 regression/legacy-085 && bun run --cwd packages/db test -- seed-idempotent`
Expected: PASS throughout. 0C's `legacy-039` (the seed is unreachable from the main barrel) must also stay green — run `bun run --cwd tests test -- regression/legacy-039` and confirm; a `export … from "./seed/reports"` on `packages/db/src/index.ts` is exactly what that regex catches.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/seed/reports.ts packages/db/src/seed/types.ts packages/db/src/seed/packs.ts \
        packages/db/src/seed/index.ts packages/db/seed/my/reports/README.md \
        packages/db/test/seed/reports.test.ts packages/db/test/seed-packs.test.ts \
        tests/regression/legacy-077.test.ts tests/regression/legacy-069.test.ts tests/regression/legacy-085.test.ts
git commit -m "$(cat <<'EOF'
feat(db): ship the reports sub-pack loader and the regression files [7A T14]

§3.4.8's `reports` loader, in 1A's two-form shape: loadReportDefinitions opens
its own tenant transaction, reportsLoader.load runs on runLoaders' (nesting
would raise ERR_TENANT_CONTEXT_NESTED). Every file is validated against the
schema, the closed DatasetId registry and the LIVE permission catalogue before
insert (F-21). A core row upserts; a tenant's clone at the same version is
refused by name rather than overwritten. 7A ships the directory and no
definition. The five §4.2.13 registration edits and no others.

legacy-077 created (7A is the plain creator per §3.7.3); legacy-069 and legacy-085
appended.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: OD-24 — the report-designer and report-viewer screens (ISOLATED; BLOCKED until the owner answers)

**This task carries no code and cannot be started.** Hazard 29 and §2.12's OD-24 row are unambiguous: "**Screenshots + operator description before any screen**", gate "every slice with a screen task", default "**screen task blocked, not the slice**". spec:79 and spec:108 say the same in the spec's own voice: "**The UI is not specified here.** Before beginning any screen, request from the owner: screenshots of the equivalent legacy screen, and a two-minute description of how a fast operator uses it. Design the new screen to be *at least as fast by keyboard*. **Do not invent workflows from this document.**"

**Files:** none until OD-24 lands — this task creates no file, and the files it *will* create are listed under "What this task will be" below.
**Interfaces:**
- Consumes: `packages/contracts/openapi.json` and the generated client (Tasks 12 and 13 put every route this screen needs into it); `packages/ui` and `packages/i18n` (0E).
- Produces: none.

**Owner provides (OD-24):**

1. Screenshots of the legacy **report list / report selection** screen and of the **report designer** (the screen that edits a `Reports` blob), including every parameter-entry dialog a user sees before a report runs.
2. Screenshots of one rendered report in **each** of the three outputs the owner actually uses today — the printed/PDF form, the spreadsheet export, and the on-screen grid — in **both** Arabic and English if both are in use.
3. A two-minute description of how a fast operator uses each: which keys they press, in what order, what they retype every time, and which reports they run more than once a day.
4. The answer to one question the designer cannot be built without: **which parts of a report a user is expected to change** — parameters only, or columns, groups and totals as well? §4.11.1's format supports all of them; the screen's shape depends entirely on the answer.

**Verify:** the four items are attached to this task in the tracker, and the description names at least three keyboard shortcuts the current operator relies on. **Until provided:** this task stays open and unstarted. Nothing else in this plan waits on it — Tasks 1–14 ship the engine, the API and the render pipeline in full, and the back office reaches all of it through `packages/contracts/openapi.json` and the generated client.

**What this task will be, once OD-24 lands** (recorded so the shape is not re-invented, not as a licence to start):

- `apps/backoffice/src/routes/reports/index.tsx` — the report list, over `GET /v1/companies/{companyId}/report-definitions`.
- `apps/backoffice/src/routes/reports/$code.tsx` — parameter entry, saved-view selection, and the three format buttons, over `POST …/reports/{code}/runs` and `GET …/report-runs/{runId}`.
- `apps/backoffice/src/routes/reports/$code.design.tsx` — the designer, over the clone, update and archive routes, scoped to whatever item 4 says a user may change.
- `apps/backoffice/src/features/reports/` — the components, built on `packages/ui`'s keyboard-first primitives, TanStack Table + Virtual for the on-screen grid, and `packages/i18n` for every string (0E's `no-hardcoded-string` lint rule fails the build on a literal).
- A Playwright spec in `tests/e2e/` re-running **test 23** on the two screens in both directions, through `bootLocalStack()` (§4.17.1, 0E).
- Targets: keyboard parity with the screenshots (spec:2254), WCAG 2.2 AA (spec:2247), both text directions verified before merge (spec:106).

**One thing this task must NOT do:** invent the workflow. If the owner's material arrives incomplete — say, screenshots but no operator description — the task stays blocked on the missing half. A plausible-looking screen built from this document is the failure spec:108's last sentence exists to prevent.

- [ ] **Step 1: Confirm the four OD-24 items are attached to this task**

Expected: all four present, item 3's description naming at least three keyboard shortcuts. If any is missing, **stop** — record what is missing on the task and move on. Do not proceed to a second step.

---

## Self-Review

Run against the spec, the contracts document's §2.8 card, §3, §4.11, §4.16, §5 and §6, with fresh eyes. Issues found are fixed inline; the list below is what was checked and what moved.

### 1. Spec and card coverage

| Requirement | Source | Task |
|---|---|---|
| `ReportDefinition` JSON format: parameters, datasets, layout (columns, groups, totals, both directions), permissions | §2.8 card, §4.11.1 | 4 (format), 8 (both directions) |
| Text-defined, diffable, version-controlled | spec:1240, spec:1246, LEGACY-077 | 4, 14 |
| `validateReportDefinition` enforcing the `ReportCode` grammar and `DatasetId` membership at seed time | §2.8 card | 4 (both), 14 (at seed time) |
| `packages/db/src/reports/datasets.ts` with every §4.16.2 dataset marked 7A — twenty-six | §2.8 card, §4.16.2 | 5 (8), 6 (7), 7 (11) |
| Each a named `withTenant` read query, never SQL text from a definition or a client | §2.8 card, test 27 | 5 (the `ref` closure seam), 14 (legacy-069) |
| An unknown id is `ERR_REPORT_DATASET_UNKNOWN` | §2.8 card, §4.2.4 | 5 |
| Core definitions from `packages/db/seed/my/reports/<slice>/<code>.json`, one directory per owning slice | §2.8 card, §4.16.1 | 14 |
| 7A itself seeds none | §2.8 card | 9 (layouts only), 14 (README, and the test that asserts zero `.json`) |
| `app.report_definition` with `cloned_from` | §4.11.2 | 1 |
| `app.saved_view` with `archived_at`, never a DELETE grant | §4.11.2, §3.5.4, hazard 25 | 2 (grant list re-asserted), 13 (archive route) |
| `app.report_run` | §4.11.2 | 2, 11 |
| Clone-and-edit through the API without a release | Phase 7 DoD | **13** (the DoD `it`) |
| `reporting.render` pg-boss job producing PDF, XLSX, CSV with a status resource | §4.11.2, spec:2206 | 10 (renderers), 11 (job), 12 (status resource) |
| RTL/LTR parity including numerals, Hijri/Gregorian and column order — test 23 for PDFs | spec:2253, §6.1 | 8 (layout), 10 (`pdf.test.ts`), 14 (legacy-085) |
| Financial-statement layouts: balance sheet and P&L, per BRANCH | §2.8 card, spec:1066 | 9 |
| Permission gates `accounting.report.read`/`.export`, `pos.report.read`, module read codes; `.export` enters here | §2.8 card, §3.6.2 | 3 (catalogue + role + `requireReportExport` and its unit test), 12 (`requireReportRead`, the data-resolved gate, with the cross-module refusal `it` that covers "module read codes") |
| §3.2.2 PDF and Spreadsheets rows | spec:1132–1133 | 10 (ADR 0016 consumed, ExcelJS) |
| §3.3 async projections read, never recomputed | spec:1204 | 6 (`party_ageing`), 7 (`stock_valuation`, `item_profitability`) |
| §3.5 report designer, feature gating | spec:1240–1241 | 4, 13, 15 (the screen, blocked) |
| §3.6 no Delphi-serialised report files | spec:1246 | 4 (`additionalProperties: false`), 14 (legacy-077) |
| §3.9 Localisation: both catalogues complete, no source-language fallback | spec:2061, LEGACY-085 | 4 (schema `minLength: 1` on `nameAr`/`labelAr`), 14 |
| §4.2.1 report codes and the `auditor` row | spec:2146–2147, 2150, 2163 | 3, 12 |
| §4.5 bulk/async with a status resource | spec:2206 | 11, 12 |
| §4.8 read replicas / graceful degradation | spec:2235, 2237 | see the gap note below |
| §4.9 report-generation SLO | spec:2245 | 5 (`MAX_DATASET_ROWS`), 11 (short transactions, the run's `finishedAt`) |
| §4.10 keyboard-first, WCAG 2.2 AA | spec:2253 | 15 (blocked on OD-24) |
| Part VI 27 re-run | §6.1 | 5, 6, 7, 14 |
| Part I LEGACY-069, 077, 085 | §2.8 card | 14 |
| OD-24 isolated | §2.12, hazard 6 | 15 |

**One partial coverage, stated rather than hidden.** spec:2235's "read replicas for reporting" and spec:2237's "if the reporting store is down, transactional entry continues" are **infrastructure** clauses, not code ones: they need a replica endpoint, which is 0C's topology (ADR 0011) and does not exist. What this slice *does* deliver against them is the part that is code — every dataset is a **read-only** query on a `tx` from `withTenant`, the render happens in `apps/worker` rather than in the request path, and `reporting.render` failing leaves the ledger untouched, so a reporting outage already cannot stop document entry. Pointing the datasets at a replica connection is a one-line change to `createDb`'s URL in the worker when a replica exists; it is **not** added here, because inventing a `DATABASE_URL_REPLICA` would be a §3.11 row this document has not allocated. Recorded in the spec-questions list below.

### 2. Placeholder scan

`grep -n 'TBD\|TODO\|implement later\|fill in details\|similar to Task\|and so on\|add appropriate\|handle edge cases\|etc\.'` over the finished plan returns **nothing**. Every code step carries real code; every test step carries real assertions with exact expected strings; the one task with no code (Task 15) says so in its title and its first line and carries the owner's four deliverables instead.

### 3. Type consistency — what was checked, and the twelve things that moved

Names were traced across every task that uses them: `ReportDefinition`, `ReportCode`, `REPORT_FILTER_OPS`, `validateReportDefinition`, `parseReportDefinition`, `ReportDefinitionError`, `Dataset`, `DatasetColumn`, `DatasetParams`, `DatasetRow`, `DatasetId`, `DATASETS`, `DATASET_IDS`, `datasetFor`, `SqlFragment`, `ReportError`, `ReportFormatters`, `intlFormatters`, `i18nFormatters`, `renderReport`, `RenderedReport`, `RenderedRow`, `RenderedCell`, `renderCsv`, `interpolate`, `reportToHtmlSource`, `reportToTypstSource`, `STATEMENT_LAYOUTS`, `statementLayout`, `statementDefinition`, `statementSectionFor`, `STATEMENT_CODES`, `statementKindFor`, `STATEMENT_EXTRA_FIELDS`, `statementRows`, `rowsForDefinition`, `assertDefinitionFields`, `ReportSeedEnvelope`, `ReportRenderer`, `rendererFor`, `REPORT_EXTENSION`, `ReportPdfEngine`, `reportPdfEngine`, `objectStore`, `setObjectStore`, `reportObjectKeyFor`, `createReportRun`, `claimReportRun`, `completeReportRun`, `failReportRun`, `loadRunDefinition`, `listReportRuns`, `ReportRunRow`, `requireReportRead`, `requireReportExport`, `resolveDefinitionForRun`, `assertParameters`, `reportDefinitionSets`, `createReportDefinition`, `cloneReportDefinition`, `updateReportDefinition`, `archiveReportDefinition`, `ReportDefinitionRow`, `createSavedView`, `listSavedViews`, `updateSavedView`, `archiveSavedView`, `SavedViewRow`, `loadReportDefinitions`, `reportsLoader`.

Twelve defects were found and fixed inline:

1. **`interpolate` used two literal control characters as brace sentinels.** A template containing either would have been corrupted, and the plan file itself became binary. Replaced with a single-pass regex that handles `{{`, `}}` and `{name}` in one `replace`.
2. **`groupKey` embedded literal `NUL` and `US` bytes.** Replaced with the named constants `GROUP_KEY_NULL` and `GROUP_KEY_SEPARATOR`, spelled as `\u0000` / `\u001f` escapes, so the source stays plain text and the separator is documented rather than invisible.
3. **`statementRows` carried a dead `byAccount` map and ran the branch query twice.** Deleted; the single query feeds `collapse` directly.
4. **`report-runs.ts` was declared as a module-level const and then read the store from `c.get("objectStore")`,** which would have needed a `Variables` member of this slice's own — and §4.2.3 makes a slice adding one amend that section first, which 7A does not do (the only member it reads beyond 0B's, 0C's and 2C's is 3B's `jobs`, amendment A5). Converted to `createReportRunRoutes(objectStore)` throughout, matching 2C's `createAttachmentRoutes` precedent, with `REPORT_RUN_ROUTE_PATH` and `REPORT_RUN_PERMISSIONS` beside it so `routes/index.ts` re-types nothing. The test helpers' `run(id, params)` signatures were unified on `DatasetId` / `Partial<DatasetParams>` in the same pass.
5. **Three datasets selected `fp.code`, and `app.fiscal_period` has no `code` column.** spec:1657–1670 gives it `starts_on`, `ends_on`, `status`, `closed_by`, `closed_at` and (from 1A) `reopen_reason` — nothing else. Every `fiscal_period_code` column now derives the label as `to_char(fp.starts_on, 'YYYY-MM')`, which is exactly the `2026-01` / `2026-02` spelling the 0A fixtures already use, and the first site carries the note saying so. `item_profitability`'s `defaultOrder` moved to `fp.starts_on desc` for the same reason. `ap.display_name` was checked in the same pass and **is** real (spec:1406), so `document_event`, `audit_log` and the saved-view test are unchanged.
6. **Two `packages/db/test` files imported `postJournal`, and §4.17.1's own text names only two importers.** `apps/worker/test/**` and `apps/api/test/**` are the two the closing paragraph lists, so the pass this item records replaced both call sites with a **file-local** `postLocal`. **That replacement was later reverted — see item 24 in §3c: 3B's amendment A21(c) makes `packages/db/test/**` the third importer, and 3B merges four phases before this slice.** What survives from this pass is the correction that stood on its own: the one always-legal crossing, `apps/worker/test` → `postJournal`, had its call sites written against `JournalLine`'s real field name, **`account`**, which had been spelled `accountId` in three places.
7. **The `apps/**/test` → `tests/support/**` crossings had no allowance at all.** 1B's widening names `tests/invariants/support/**` only, and 0B's `dependency-rule` has no allow-list mechanism — it reports every relative specifier that resolves outside the importing workspace. Task 10 now carries **Step 8**, which widens the allowance to both shared directories under the same narrow importer guard, adds the two tsconfig `include` lines, and tells the implementer to `grep` first because 2C's own API tests import `tests/support/api.ts` and may already have done it. Without this step Task 10 and Task 12 both fail `lint:rules` for a reason neither task mentions.
8. **The saved-views isolation probe expected 403 where the code answers 404,** and the plan's own sentence said why: RLS removes the other tenant's row, so `getSavedView` returns `null` and `ERR_NOT_FOUND` is raised before `assertOwner` can run. Corrected to 404, with the reasoning written out and the contrast to `report-runs` (which really is 403, because `requireReportExport` gates on the path parameter before any row is read) stated beside it.
9. **`assertOwner` raised `ERR_VALIDATION_FAILED` while its own doc comment and its test asserted `ERR_RBAC_FORBIDDEN`.** The test would have failed. An owner refusal is a 403, not a malformed request, so `ReportErrorCode` gains a fourth member and `assertOwner` raises it; the `asAppError` branch already maps by code, so nothing else changed. The saved-view routes' 403 uses the same real code — the `ERR_FORBIDDEN` first written there is not in `ERRORS` at all.

10. **The File Structure tree and the DoD table named the wrong task for thirty-six rows.** Both columns were written before the fifteen task numbers settled and had drifted by one from T10 on: `run-store.ts` said T12 where the run store is Task 11, `saved-view-store.ts` said T14 where it is Task 13, `pdf-source.ts` and the three engine files said T11 where they are Task 10, and the four seed-loader rows said T15 where they are Task 14. All thirty-six were re-derived from the `### Task` headings. **The same pass deleted a row for a file that does not exist:** the tree listed `tests/invariants/job-probes.ts`, and there is no such file — §4.2.6 puts `JOB_PROBES` in `tests/invariants/probes.ts` beside `PROBES`, and the surviving row now names both registries.
11. **Task 10's verify command for the lint allowance would always have reported a false hit.** `grep -n "tests/support" scripts/lint/rules/dependency-rule.ts` matches 0B's own prose comment about `tests/support/ledger.ts` (0B:5067) on a clean head, so an implementer would have read "make no change" and then watched Tasks 10 and 12 fail `lint:rules`. The probe is now `grep -n "TEST_TIER_SHARED"`, and the step says in as many words that a hit on prose is not an allowance. The same step was rewritten to say what 1B **actually** left — two allowances described in comments with the guard's code never written, one of them a no-op because `run.ts` walks no `tests/**` file — so the implementer reconciles rather than hunting for a branch that is not there.
12. **A definition could name a column its dataset does not have, and nothing would catch it.** `columnOf` (Task 5) raises for a filter or a sort key at RUN time; `columns[]`, `groups[]` and `totals[]` were checked by nothing at all, so a typo rendered as a silently empty column whose total still added up — wrong output that looks right, which is the failure this slice exists to end. `validateReportDefinition` cannot do it (it takes the dataset **ids** and the permission codes as two `ReadonlySet<string>`; a `DatasetColumn`'s `ref` is a `packages/db` closure §3.1 keeps out of domain), so `assertDefinitionFields` ships in Task 9's `packages/db/src/reports/statement.ts` and is called by the definition store's `assertValid` **and** by the seed loader (Task 14) — the two choke points create, clone, update and every pack row pass through. It is one exported function rather than a module-private copy in each, because two spellings drift, and because it is the function that knows a `STATEMENT_CODES` key's rows carry `section` / `branch_code` / `branch_id` on top of its dataset's columns — without that union every statement definition would be unstorable and unseedable. A route test asserts it, and the invalid-body test no longer claims a `/columns/0/field` JSON Pointer that nothing could ever have produced.

### 3b. Second review pass — eleven further defects fixed

A later review of the finished plan found eleven more, all fixed inline above.

13. **Task 4's `base()` fixture was invalid under the validator the same task ships.** It declared columns `account_code` / `base_debit` / `base_credit` but grouped on `account_type`, which validator rule 4 refuses — so `"accepts the base definition"` and every later `it` asserting an exact `errors` array off it would have failed. `account_type` is now `base().columns[0]`, and the duplicate-column expectation moved from `/columns/3/field` to `/columns/4/field`.
14. **The multi-error `it` asserted push order where the validator sorts by path.** `errors.sort` puts `/groups/0/field` before `/sort/0/field` before `/totals/0/field`; the expectation now says so.
15. **The financial-statement layouts could not be stored, seeded or run.** `statementDefinition` emits `section` as a column, group and sort key over `account_balance`, which declares no such column, so the field check refused every statement — and the render handler called `datasetFor(...).run` directly, leaving `statementRows` unreachable outside its own test. Task 9 now ships the dispatch the header always promised: `STATEMENT_CODES` / `statementKindFor` / `STATEMENT_EXTRA_FIELDS` in domain, and `rowsForDefinition` / `assertDefinitionFields` in `packages/db/src/reports/statement.ts`. The handler (Task 11), the definition store (Task 13) and the seed loader (Task 14) all go through those two functions, and Task 13's module-private `assertFields` is gone.
16. **The header's produced-interfaces block named three exports no task shipped** (`STATEMENT_CODES`, `rowsForDefinition`, `assertDefinitionFields`). All three now exist; the block also lists the rest of the statement surface 7B and 7C import, and no longer claims "§4.11.2 verbatim" when two amendments are recorded against it.
17. **The seed loader wrote the definition FORMAT version into `report_definition.version`.** The schema pins `definition.version` to `const 1`, so every seeded core row would have been version 1 forever and §4.16.1's `version = 2` rule — which 7B and 7C depend on for eight re-expressed codes — would have been unimplementable. The file is now the `{ definitionVersion, definition }` envelope of §4.3.7's precedent (and of 7B's own amendment A1); the file-name check, the README, the loader tests and `legacy-077` all follow it, and `seedReportDefinition`'s option is `definitionVersion` for the same reason.
18. **Task 12's "requires BOTH" `it` expected 403 where the handler answered 404**, and Task 13's isolation-probe note described a gate order the handler did not have. `requireReportExport` now runs **before** `resolveDefinitionForRun` on the POST, matching both GET handlers, so the route is never an existence oracle and the probe note is true.
19. **Test 23's re-run asserted labels and column order but never numerals or the calendar**, which the §2.8 card names explicitly. `pdf.test.ts`'s fixture moved to `ledger_entry` with an `effective_date` column and a dated row, and three assertions now compare the rendered PDF text against strings computed from `@dulja/i18n` — Hijri in the Arabic render, Gregorian in the English, and the Arabic-Indic money digits — so the numeral and calendar policy stays 0E's rather than becoming a second one here.
20. **Task 2's `report_run` test called `digest('x','sha256')`**, a pgcrypto function; Plan 0A creates only `btree_gist` (plan0A:952). It is now `sha256('x'::bytea)`, the PostgreSQL 18 builtin 4B already recorded.
21. **`packages/domain/src/reports/error.ts` was in the File Structure but no task created it**, and the cycle it existed to break was back: `codes.ts` imported `ReportDefinitionError` from `./validate` while `validate.ts` imported from `./codes`. The class now lives in its own module, both sides import it, and the barrel re-exports it.
22. **Task 3 left `bun run lint:rules` red for nine tasks**, contradicting Global Constraints, the DoD table and the File Structure — which already assigned `apps/api/src/reports/authorise.ts` to Task 3. Task 3 now creates that file with `requireReportExport` and a unit test; Task 12 appends the other three helpers. Only Tasks 5–7's `typecheck` is deliberately red, and they are stated as one PR.
23. **The POST handler reads `c.var.jobs`, an eighth `Variables` member the contracts document has not granted.** It is 3B's amendment A5. The Consumes block, the Self-Review and the handoff amendments table now say so, with A5 marked as a **⚑ BEFORE** row, and the Self-Review no longer claims the set "stays at seven".

Two more things moved without being defects. `report_run.lang` is `char(2)` in the DDL, so the Drizzle mirror now says `char("lang", { length: 2 })` rather than `text()` — ADR 0002 makes the mirror the diff source and a `text()` there would make `drizzle-kit` report a phantom change on every run. And `loadRunDefinition` now returns the company's `base_currency` alongside the run and the definition, because the render handler was calling `i18nFormatters(lang)` with no currency: datasets like `item_profitability` and `stock_valuation` carry no per-row `currency` column, so every money cell would have rendered as `XXX 1,234.50` — a wrong report rather than a failing one, which is the worst kind.

### 3c. Third review pass — an independent audit of this plan against the contracts document, Plan 0A and the spec

Ten findings were filed — three major, seven minor. **All ten are real and all ten are fixed.** One (item 25) is fixed by a different route from the one proposed, because the proposed route is arithmetically impossible; one (item 24) follows the proposal but corrects the source it cites. Both reasons are recorded in place. Item 34 was found while applying the rest and was not in the audit.

24. **The `postLocal` duplication rested on a restriction that no longer exists.** Item 6 above moved both `packages/db/test` files off `postJournal` because §4.17.1's closing paragraph names two importers. **3B's amendment A21(c) makes it three** — 3B Task 7 Step 9 (3b:55, 3b:3333) adds the `packages/db/test/**` → `tests/invariants/support/**` allowance to `scripts/lint/rules/dependency-rule.ts` and the `"../../tests/invariants/support/**/*.ts"` entry to `packages/db/tsconfig.json`, precisely so DB-tier suites can post through the real helper — and 3B is a merged dependency of this slice. Both files now import `postJournal` and `JournalLine`; the two copies of the fifteen-line wrapper are gone, along with the `withProdTenant` alias, `draftDocument` and `uuidv7` in those files. **One correction to the finding itself:** A21(c) is **not** folded into §4.18 round 3 — round 3 states in as many words that it leaves each slice's own Task 0 amendments to that slice's PR, and its table carries no A21 row. The allowance is a fact of the merged **code head**, sourced to 3B's plan, which is why Task 5's Consumes block now carries the two greps that confirm it and says to stop and raise rather than re-copy the helper if either is missing.
25. **Task 9's balance-sheet `it` asserted an identity the fixture cannot satisfy.** `asset 8000 + liability −2000 + equity −4000` is `+2000.0000`, not zero, so the `it` failed as written. **The proposed repair — add a −2000 retained-earnings row — is arithmetically impossible to reconcile:** it zeroes the balance-sheet subset only by unbalancing the whole trial balance, and raising an asset to re-balance the whole puts the subset back at +2000. In a **pre-closing** trial balance with a non-zero period result the two cannot both hold; that is the accounting, not the fixture. The fixture is therefore unchanged (Σ over all six rows is 0, exactly as its heading claims) and the assertion is now the identity that is true and that `statement-tie-out.test.ts` already proves against the database: **balance-sheet net + P&L net = 0**, with `net(bs) = 2000.0000`, `subtotal(asset) = 8000.0000` and `liability + equity = −6000.0000` asserted beside it, and the reason written into the test.
26. **Task 8's `renderCsv` `it` read the grand total one line too early.** Six rows plus one header means the total is `lines[6]`; `lines[5]` is the income subtotal. All eight elements — including the empty string after the trailing CRLF — are now asserted by name, so the next off-by-one cannot hide behind a sampled index.
27. **Task 4's duplicate-parameter `it` provoked a fourth error it did not expect.** Replacing `def.parameters` un-declares `fiscalPeriodId`, which `base()`'s one filter still names, so validator rule 5 pushed `/dataset/filters/0/param` and the exact three-element assertion failed. The `it` now clears `def.dataset.filters` — rule 5 has its own `it` two above — and says why.
28. **Task 8's date expectation assumed day-first ordering from a bare `en` tag.** ICU resolves `en-u-ca-gregory-nu-latn` to en-US: `Jan 15, 2026`. Verified against the toolchain (Node 24 / ICU 77) rather than reasoned about. The expectation is corrected, and it is the same string 0E's `formatDate(iso, ctx, "medium")` produces for `en` (0e:786–795) — which matters, because Task 10 replaces this formatter with an adapter over that function and a report must not change shape when it moves to the worker.
29. **Migration `0076.down.sql` omitted §3.4.5's permission-seed rollback precondition.** §3.4.5 requires the file to say that such a down is reversible only against an unseeded database and that `--only roles` is re-run after re-migrating, and requires the task to state the precondition on its rollback command; 6A's `0062.down.sql` and 6B's `0063.down.sql` are the written precedents. Both are now present, in 6A's wording, with the command spelled `db:rollback 75`.
30. **Task 12's import block omitted two helpers its own handler calls.** `requireReportRead` and `assertParameters` are Step 4's and are called eight lines below; the block named only `requireReportExport` and `resolveDefinitionForRun`, so the file did not compile. All four are imported now.
31. **Task 12 still claimed Task 3 leaves `lint:rules` red.** Item 22 moved `authorise.ts` into Task 3 and Task 3's own Step 8 says a red `lint:rules` there is not an expected state. Task 12's Expected line now says the rule was already green from Task 3 and what a red one there would actually mean, and the stale paragraph is out of its commit body.
32. **The Produces block for `datasetWhere` / `datasetOrderBy` was one parameter short of the implementation.** Both take a trailing dataset `id` (default `"unknown"`) that `defineDataset` fills from `spec.id` and that every error message in Task 5's tests depends on. The signatures now declare `id?: string` and say so.
33. **Task 3's role assertion used a dynamic import, in the wrong file.** 0D created `packages/db/test/roles-seed.test.ts` and 1A appended its three role `it`s there with top-level static imports of `ROLES` and `PERMISSIONS`; a dynamic `await import(…)` reads as dodging a lint that does not exist, and a role assertion is an odd tenant for a DDL test file. The `it` moved to `roles-seed.test.ts` in the static form, and Task 3's Files list, run commands, `git add` line, the File Structure tree and the DoD table follow it. Task 1 Step 4's "all six `it`s" claim for `report-definition.test.ts` is true again.
34. **A money expectation in the same Task 8 `it` turned on an invisible character.** `currencyDisplay: "code"` separates the code from the amount with U+00A0, and the expected string carried a literal NBSP — correct, and unreadable: the next reader sees a plain space, an editor that normalises whitespace silently breaks the `it`, and the failure names no cause. Not a defect, a trap. The assertion now normalises the separator by code point and pins it with `charCodeAt`, and no line in the file carries a non-ASCII space. Verified against the same Node 24 / ICU 77 run that settled the date format.


### 4. Contracts compliance — the checks a reviewer will run

- **Migrations** are 0074, 0075, 0076 only; each has a hand-written `NNNN.down.sql`; the 0075 name is §2.8's own (`0075_create_saved_view_report_run.sql`, which names both tables §3.4.2 requires it to name); no `create index concurrently`; every statement comments its LEGACY-/spec reference; **no migration asserts `max(version)`** (hazard 14).
- **`lint-schema.ts` is never opened.** §3.5.3 gives all three tables no set membership, so all three carry `id`, `created_at` and `audit_row`, and the six sets are exactly as 5A left them. Tasks 1 and 2 assert `lintSchema` returns zero violations for each table instead.
- **`privileges.test.ts`** gains one `it` re-asserting 2B's unchanged five-row DELETE list and nothing else (§3.5.4, hazard 25). §3.5.4's closing sentence and the §2.8 card both read "7A … does not touch `privileges.test.ts`", so the Execution-handoff amendments table asks for that sentence to become "7A adds no grant; it re-asserts the pinned list in `privileges.test.ts` and changes nothing else." The addition is purely additive and proves the fact rather than assuming it, but the two documents must not disagree in plain text.
- **`fixtures.ts`** gains exactly `seedReportDefinition` — §4.17's one row for this slice — additively, with the uniform `(db, s, opts?)` shape (hazard 9).
- **§4.17.1** gains no helper. `pdfText`, `postJournal`, `sharedDb`, `thinRegression`, `sourceFiles`, `repoFile`, `grantAdmin`, `problemOf` and `startWorker` are consumed as they stand. Two of the consumers are `packages/db/test/**` files (Tasks 5 and 9, both calling `postJournal`), which is the **third** importer 3B's amendment A21(c) opened (3b:3333) rather than a fourth one this slice asks for; §4.17.1's closing paragraph still says two, because round 3 left A21(c) in 3B's own PR.
- **`ERRORS`** gains exactly `ERR_REPORT_DATASET_UNKNOWN`, which §4.2.4 had already allocated to the report engine. No other code is invented; a bad definition is `ERR_VALIDATION_FAILED` with JSON-Pointer `errors[]`, which §4.2.4's A10 amendment already permits.
- **`JOBS` stays closed at sixteen.** `reporting.render` was already in it; only `JobPayload` and `JOB_PROBES` grow, by one key each.
- **Route modules:** two new (`report-definitions`, `saved-views`) plus `report-runs`, each with one `PROBES` entry keyed by its exact path; the runs `POST` is a **sub-path on 1B's existing module** and needs none (hazard 31). **7A adds no `AppEnv["Variables"]` member; it consumes 3B's `jobs`** — amendment A5 (3b:39) makes `jobs: JobClient` the eighth member and Task 12's `POST …/runs` reads `c.var.jobs` to enqueue on the posting transaction, so A5 must be in §4.2.3's head before Task 12 compiles (Execution-handoff amendments table). `AppDeps` stays at six.
- **Hazards:** 1 (no statutory figure — nothing in this slice touches one), 2 (no MyInvois detail — the `tax_transaction` dataset reads columns 5A created and names no LHDN field), 3 (no Firebird assumption), 5 (Task 15's owner-provides pattern), 6 (OD-24 is one isolated task), 7 (D1–D27 untouched), 8 (Plan 0A helpers cited by exact name and never renamed), 9, 10 (per-tenant rows are seed-pack data), 11 (no enum label added), 13, 14, 20 (system principal, short transactions), 21 (no `sql.unsafe`), 22 (nothing writes a ledger, movement, layer, projection or tax-transaction table — every dataset is a `select`), 25, 26 (one code, no new module), 29 (Task 15), 30 (ADR 0016 consumed, never re-evaluated), 32 (four registers respected; the `DatasetId` additions are §4.16.2's own rows), 35.

### 5. What a reviewer should look at first

The **`ref: (tx) => tx\`l.account_id\`` closure** in `DatasetColumn` (Task 5) is the load-bearing idea of the whole slice: it is what makes "a definition never contributes SQL text" a structural fact rather than a convention, and every one of the twenty-six datasets depends on it being right. If `postgres`' exported `PendingQuery`/`Row` type names differ in the installed version, alias them in `sql-fragment.ts` — a `string` return type there silently re-opens LEGACY-036/037/069 and is the one shortcut this plan forbids by name.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-09-05-dulja-phase-7a-report-engine.md`.** Fifteen tasks; Tasks 1–14 ship the engine end to end, Task 15 is OD-24 and is blocked, not startable.

**Execution order and what may run in parallel.** Tasks 1 → 2 → 3 are one migration per PR and are strictly serial (each is its own PR — spec:2057). Task 4 needs none of them and may start immediately beside Task 1. Tasks 5 → 6 → 7 are serial (they fill one registry file and Task 7 is what makes it compile) and land as **one PR**. Task 8 depends only on Task 4. **Task 9 needs 4, 8 and 7** — its domain half is pure layout, but `packages/db/src/reports/statement.ts` imports `datasetFor` and `ReportError` from the registry, and it is where `rowsForDefinition` and `assertDefinitionFields` are written. Task 10 needs 8; **Task 11 needs 2, 9 (`rowsForDefinition`) and 10** plus the run store; Task 12 needs 3 and 11; **Task 13 needs 1, 4, 9 (`assertDefinitionFields`) and 12** (it reads `ReportParametersSchema`); **Task 14 needs 9 and 13**. The single longest chain is 1 → 2 → 5 → 6 → 7 → 9 → 11 → 12 → 13 → 14.

**One task ends deliberately red, and its commit body says so.** Task 5 leaves `bun run typecheck` failing on `DATASETS` not satisfying `Record<DatasetId, Dataset>` until Task 7 closes the registry — a `Record` over a closed union genuinely cannot compile until every member exists. It is intended; a reviewer who "fixes" it by loosening the type has broken the check that made the gap visible. **Tasks 5, 6 and 7 are therefore one PR**, and Task 5's commit step says so: three commits, one branch, one merge, so the merged head is never red.

**Task 3 is no longer among them.** It used to leave `bun run lint:rules` failing on `permission-catalogue` for nine tasks; it now ships `apps/api/src/reports/authorise.ts` with `requireReportExport` — the `PERMISSION[…]` reference §3.6.3's rule looks for — exactly as the File Structure always assigned it, so every one of the five commands is green at the end of every task except the 5–7 typecheck above.

**Before Task 1, confirm the merged head.** `bun run lint`, `bun run lint:rules`, `bun run format:check`, `bun run typecheck` and `bun run test` are green on the Phase 5 head, and `bun run --cwd packages/db db:lint` reports zero violations. Then check the one conditional this plan reads: `ls packages/db/migrations/0051_*.sql` — a hit means 4B's OD-09 task ran and the `pdc` dataset stays; a miss means Task 6 drops the `pdc` member, its registry entry, its export and its test block, and the twenty-six-member assertion becomes twenty-five. That is the only branch in the plan.

**Amendments this slice asks the contracts document for.** §4's rule is that the contracts document changes **before** the code does (§3.10), so the four rows marked **⚑ BEFORE** must be folded into §4.18 round 3 by the architect *before* the task beside them executes — an executor who reaches one of those tasks and finds the row unlanded should stop and raise it rather than implement against a document that says something else. Every other row is recorded in the PR that ships its task.

| § | Amendment | Task |
|---|---|---|
| **4.2.3** ⚑ BEFORE | **Ratify 3B's amendment A5**: `AppEnv["Variables"]` gains an eighth member `jobs: JobClient`, set by the two-line middleware in `apps/api/src/app.ts` from `deps.jobs` (3b:39, 3b:3260). **7A adds no member; Task 12's `POST …/runs` reads `c.var.jobs`** to enqueue `reporting.render` on the same transaction as the `report_run` insert, and does not compile without it. §4.2.3's "the registered set is seven members" sentence becomes eight | 12 |
| **4.11.2** ⚑ BEFORE | `statusUrl` becomes `"/v1/companies/<companyId>/report-runs/<runId>"`. **No slice mounts `/v1/jobs/{jobId}`** — §4.2.7 lists the path and assigns it to no module, and 6A already dropped its own `statusUrl` for the same reason. ADR 0067 records it | 2, 12 |
| **3.11** ⚑ BEFORE | The four `R2_*` names' Holder column becomes **`api, worker`**; `containerSecrets(env, "worker")` supplies them | 10 |
| 4.11.1 | `code`, `permission` and `dataset.source` are `string` in the **generated** type (a JSON Schema cannot express a brand or a cross-package union); the pattern is the schema's and the membership is `validateReportDefinition`'s, which takes both closed sets as **parameters** — 1A's `validatePolicy(definition, catalogue)` shape | 4 |
| 4.2.4 | `apps/api/src/problem.ts` gains one `asAppError` branch for `ReportError` (`packages/db`) and one for `ReportDefinitionError` (`packages/domain`), on the `PostingError` / `PolicyEvaluationError` precedent | 5 |
| 4.2.13 | `SubPack` gains `"reports"` (last in `SUB_PACKS`); `PHASE_0_SUB_PACK_DIRECTORIES` gains the directory; `OWNED_ELSEWHERE` loses the row. The five edits §4.2.13 reserves, and no others | 14 |
| 4.2.6 | `JobPayload["reporting.render"] = { runId: string }` | 11 |
| 4.17 | `seedReportDefinition`'s options are `{ code; definition; definitionVersion?; isCore?; clonedFrom? }` returning the row id — the register's row, filled in, **landed in the same PR as Task 1** as §4.17's own additive-option rule requires. The row version is `definitionVersion` and never `version`, so it cannot be confused with `ReportDefinition.version`; 7B's amendment A8 asks for the same two spellings and is satisfied by this row | 1 |
| **4.16.1** ⚑ BEFORE | **The report seed file is an envelope**: `packages/db/seed/my/reports/<slice>/<code>.json` is `{ "definitionVersion": <int ≥ 1>, "definition": <ReportDefinition> }` and nothing else — the §4.3.7 document-type precedent. `definitionVersion` is `app.report_definition.version`; `definition.version` stays §4.11.1's **format** version, which the JSON Schema pins to `"const": 1`. Without the envelope the loader has no source for the row version and §4.16.1's own rule — "a definition seeded for a code an earlier slice already served upserts on `(company_id, code, version)` at `version = 2`" — is unimplementable, so 7B's five re-expressed codes and 7C's three could never be seeded. 7B's amendment A1 asks for exactly this shape | 14 |
| 3.5.4, 2.8 (7A card) | "7A adds no grant and **does not touch `privileges.test.ts`**" becomes "7A adds no grant; it **re-asserts the pinned list** in `privileges.test.ts` and changes nothing else." Task 2 Step 6 appends one `it` re-asserting 2B's unchanged five rows — additive, and it proves the fact rather than assuming it (hazard 25) — but the contracts text as written says the file is untouched | 2 |
| 4.17.1 | The test-tier import allowance covers **two** shared directories, not one: 1B opened `apps/*/test/**` → `tests/invariants/support/**`, and `tests/support/**` needs the same opening because `pdfText` (2C) and `problemOf`/`grantAdmin` (0B) live there and 2C's own `apps/api` tests already import them. §4.17.1's closing paragraph should name both directories; the importer half stays exactly as narrow. **In the same pass, its "two files outside the `tests` workspace" sentence should read three**: 3B's amendment A21(c) added `packages/db/test/**` in 3B's own PR (3b:3333) and round 3 recorded no row for it, so the document is a merged slice behind the head. 7A relies on that allowance in Tasks 5 and 9 and adds nothing to it | 10 |
| 4.6.1 | `app.fiscal_period` has **no `code` column** (spec:1657–1670). Every dataset exposing a period label derives it as `to_char(fp.starts_on, 'YYYY-MM')`, which is the `2026-01` spelling the 0A fixtures already use. Worth a line in the table register so the next slice does not select a column that has never existed | 5, 7 |

**Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration. This plan is written for it: every task states its `Files`, its `Consumes` and `Produces` with exact signatures, and repeats every literal an implementer needs, because a task's implementer sees only their own task.

**2. Inline Execution** — `superpowers:executing-plans`, batch execution with checkpoints. Reasonable for Tasks 1–3 (three small migrations) and 5–7 (one registry filled in three passes); Tasks 10–13 each carry enough surface to deserve their own review gate.

**Which approach?**

