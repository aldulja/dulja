# Dulja Phase 9A — Extraction, Profiling, Reconciliation Reports, Legacy Catalogues — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `packages/importer` far enough to *read* the live legacy Firebird database and *report* on it — row counts and date ranges per table, which of the seventeen legacy modules are actually in use, six reconciliation reports that recompute every drifting aggregate from `VouItems`/`BillItems` and quantify the difference, the catalogue of report-template blobs, the answers to Part VII's open questions, and an anonymised snapshot — so that the owner can decide the cut-over treatment and 9B can load against numbers somebody has already explained. **This slice loads nothing and writes no schema.**

**Architecture:** One package, three layers, and a port at the bottom. `LegacyDriver` (`packages/importer/src/legacy/types.ts`) is the only thing that knows a database exists; it takes a **structured `SelectSpec`**, never SQL text, and has exactly two implementations — `OdbcLegacyDriver` (the live Firebird connection, ADR 0081) and `FixtureLegacyDriver` (an in-memory corpus, the local equivalent every task is developed against). `LegacyReader` (`packages/importer/src/reader.ts`) is the §4.13.1 surface 9B consumes: `tables`, `count`, `dateRange`, `read`. Above it sit pure functions — `profile`, six `reconcile` kinds, the template catalogue, the open-question probe, the snapshot — each of which takes a `LegacyReader` and returns a plain object, so every one of them is unit-tested against the fixture corpus with no database at all. SQL text is rendered in exactly one file (`packages/importer/src/drivers/sql.ts`) from catalogue-validated identifiers with every value bound as a parameter. Nothing in this slice touches PostgreSQL, opens `withTenant`, creates a table or writes a migration.

**Tech Stack:** Bun 1.4 · TypeScript strict · `odbc` (the live Firebird connection; the DSN is the owner's, ADR 0081) · `decimal.js` (exact recomputation of legacy aggregates — no `number` ever holds a monetary value) · **no `@dulja/contracts` import** — this package raises a plain `Error` carrying `ERR_IMPORT_SOURCE_UNREADABLE` and may not import `AppError` (§4.13.1, §3.1) · Vitest (under Node 24) with no Testcontainers in this package · Node's `node:crypto` for artefact hashes and snapshot pseudonyms.

**Spec:** `docs/spec/rebuild-spec.md` v1.2 — §5.1 Migration hazards in full (spec:2329–2344), §0.1 Provenance (spec:61–81), §0.2 Operating brief (spec:97–110), §0.4 Glossary in full (spec:144–180), §3.9 Naming/identifiers/money/deletion/error-codes (spec:2037–2063), §4.11 Engineering practice incl. "load tests against realistic data volumes — take the real row counts from the customer's live database before sizing" (spec:2267), Part V Phase 9 row (spec:2295) and sequencing (spec:2301), Part VI (this slice owns no test), Part VII #1, #2, #4, #5, #6, #7, #8, #9, #10, #13 (spec:2461–2477), Part I §A and §C — LEGACY-001…024, 049…052, 066, 073, 074, 077, 078 — read as data-quality expectations. Companion dossier: `docs/spec/legacy-system-analysis.md` (the 460-table inventory in its Appendix A is the source of this slice's module map).

## Assumptions and contracts (from docs/superpowers/plans/2026-09-05-dulja-plan-contracts.md)

- **Slice:** 9A — Extraction, profiling, reconciliation reports, legacy catalogues. **Phase:** 9. **Phase gate:** **none beyond 0B.** Contracts §6.3 places 9A on its own branch off 0B — "9A ∥ anything after 0B (OD-17)" — and the card's *Depends on* row says "otherwise nothing; **may run at any time after 0B**", because its row counts size the Phase 1 and 3 load tests (spec:2267). This plan therefore does **not** wait for the Phase 0 exit gate, and must not acquire a dependency that would make it wait.
- **Depends on (merged):** **0B** only. **Nothing under `packages/importer/src/**` imports a value or a type from `@dulja/contracts`** — §4.13.1 says this package "has no HTTP surface and may not import `@dulja/contracts`' error class (§3.1)", so `AppError`, `ERRORS`, `ErrCode`, `ErrorDef` and `Problem` are **not** consumed here and an executor who imports one of them has broken §3.1. The single interaction with that package runs the other way: **9A adds one row to `ERRORS` in `packages/contracts/src/errors.ts`** (Task 4 Step 5, `ERR_IMPORT_SOURCE_UNREADABLE`), which is a modification of another package's file and not a dependency of this one — `packages/importer/package.json` therefore declares **no workspace dependency at all**. Consumed by exact name from 0B: the `scripts/lint/` runner and its five rules — `no-bare-db`, `no-sql-concat`, `dependency-rule`, `forbidden-log-fields`, `error-codes` — with their `SourceFile`/`LintViolation`/`LintRule` types in `scripts/lint/types.ts` (§3.7.5); the root scripts `bun run lint`, `lint:rules`, `format:check`, `typecheck`, `test`; the `tests/` workspace and its `tests/vitest.config.ts` (§3.7.1). **Plan 0A helpers are cited but not used:** this package opens no PostgreSQL connection, so `startDb`, `withTenant`, `uuidv7`, `seedTenant`, `Seed`, `draftDocument` and `lintSchema` appear nowhere in `packages/importer`. Hazard 8's rule ("cited by their exact names and never renamed") is satisfied vacuously and `packages/db/test/fixtures.ts` is not touched.
- **Deliberately NOT depended on:** `@dulja/db` and `@dulja/domain`. Contracts §3.1 permits `packages/importer` to import all three tiers and 0B's `dependency-rule` already carries the row `"packages/importer": ["@dulja/domain", "@dulja/db", "@dulja/contracts"]` — but `Money` is **0D's** (§4.2.1) and `withTenant` is 0B's production export in `@dulja/db`, and taking either would silently make 9A wait for 0D and contradict the card. **`@dulja/contracts` is not depended on either**, for the different reason given above: §3.1's row is an allow-list of what this package *may* import, not a list of what it must declare, and 9A imports nothing from it. `packages/importer/package.json` at 9A therefore declares exactly two dependencies — `decimal.js` and `odbc` — and no workspace reference. Legacy monetary figures are carried as **decimal strings** and computed with `Decimal` — permitted by `no-number-money`, which requires `Money`, `Quantity`, `Decimal` or `string` (§3.7.5). **9B adds `@dulja/domain` and `@dulja/db`** when it posts through `postDocument`; nothing in this plan blocks that.
- **Migration numbers:** **none.** Contracts §3.4.1 reserves **0100** for 9A and the card says "0100 (reserved; the profiler writes reports, not schema)". This slice writes no file in `packages/db/migrations/`, creates no table, and therefore triggers none of §3.3's new-table obligations (`tenant_id`, RLS, `attach_audit`, composite FKs, a two-tenant test). **0100 stays unused**; gaps are legal (§3.4.1) and no later slice may claim it. **ADR numbers:** 0081–0083 (§3.9) — `docs/adr/0081-firebird-version-and-extraction-method.md`, `docs/adr/0082-legacy-predicate-and-identifier-allow-list.md`, `docs/adr/0083-legacy-artefact-format-and-anonymisation.md`.
- **Interfaces consumed:** §3.1 package tiers and the `packages/<pkg>/src/cli.ts` rule; §3.2 identifiers/money/naming/error-codes/logging; §3.3 the never/always lists and the three homes of `sql.unsafe`; §3.7.1 test layout; §3.7.3 regression-file ownership **and its first corollary** (9A always appends, create-if-absent); §3.7.5 the five 0B lint rules; §4.2.4's **allocated code space and its `error-codes` build check** — read as the registry that already reserves `ERR_IMPORT_SOURCE_UNREADABLE` for this slice, **not** as an envelope this package constructs: no `Problem` is built and no `AppError` is thrown anywhere in `packages/importer`.
- **Interfaces produced:** **§4.13.1 verbatim** — `LegacyReader`, `ProfileReport`, `ReconciliationReport`, `profile(reader)`, `reconcile(reader, kind)` — and **`LegacyPredicate`**, which the §4 preamble names as one of the five types "owned outright by the slice that implements the enclosing function" and assigns to 9A ("9B *consumes* it through `LegacyReader.read` and never redefines it"). Everything else this package exports is internal to Phase 9 and listed under *Names this slice adds* below.
- **The card's "typed row readers" bullet resolves to `read<T>` plus a per-report local row shape, and this plan says so rather than inventing per-table interfaces.** The 9A card's first *Delivers* bullet reads "`LegacyReader` over Firebird (version-dependent, ADR 0081), **typed row readers for the tables named in §5.1 and §0.4**". §4.13.1 itself defines no such types: the frozen surface is the generic `read<T>(table, opts): AsyncIterable<T[]>`, and every caller in this slice instantiates `T` as `LegacyRow` or `Record<string, string | boolean | null>` — the only shape an ODBC read can honestly produce, because assumption 6 casts every column to text and the column set of each legacy table is read from the customer's catalogue at run time, not known at compile time. Writing a `VouItemRow`/`BillItemRow`/`EmployeeRow` here would mean transcribing column lists this project has not confirmed against a live database, which is the class of invention hazard 3 forbids. **The reading is therefore: "typed row readers" = `read<T>` plus each report's own local row shape**, and contracts §4.18 Round 2 has already settled it in exactly those words ("Typed row readers resolves to `read<T>` plus each report's own local row shape; **no per-table row interface in 9A and none invented in 9B** until a live catalogue is read"), with the §4.13.1 closing note and the §2.10 card's *Delivers* bullet both rewritten to match. 9B inherits a settled answer, not an unmet bullet.
- **Owner decisions:** **OD-17** (read access to the live legacy database; Firebird version — spec:2409, 2469) → **Task 3**, isolated; default per §2.12 is *none*, so the local equivalent is `FixtureLegacyDriver` over the committed corpus and every later task runs green without the owner. The card calls this "Task 1 … the scoping task" and hazard 3 repeats it; it is Task 3 here because Tasks 1 and 2 build the seam it plugs into and neither touches the owner's database. Task 3 is still **the first task that reads a live byte** — "scope first, migrate second" (§5.1 #10) is preserved, and dropping Task 3 leaves every other task green. **This is no longer a divergence: contracts §4.18 Round 2 has already ratified it.** The row "**The scoping report is 9A Task 3, not Task 1** — Tasks 1–2 build the driver port and the renderer and read no customer data; §5.1 #10 is unchanged" is in the table, and the §2.10 9A card's *Owner gates* cell now reads "the scoping report is the first task that reads the owner's data: 9A Task 3". The Execution handoff's item 5 is therefore a **verification**, not a request. (One stale contradiction remains in the contracts document and belongs to its architect, not to this plan: §2.12's OD-17 row still reads "9A → Task 1 (scoping)". An executor who hits it reads §2.10 and §4.18, which agree with each other and with this plan.) **OD-16** (must historical POS data migrate? Part VII #10 ⚠️ — spec:2474) → **Task 6**, isolated; default per §2.12 is *start clean*, so `mposStandard`/`mposSystem` are **not** profiled unless `--include-mpos` is passed. **OD-27** (Part VII #6 real DDL constraints, #7 `MatOpens.Job`, #8 templates in use, #9 customisations, #13 Salaries module live? — spec:2470–2473, 2477) → **Task 13**, isolated; default per §2.12 is *none*, so the task ships the probe that produces the answers and records "unanswered" until it is run against the live database. **OD-25** (suspense treatment; cut-over date — spec:2334) is **9B's** gate, not this slice's: Task 8 produces the *input* the owner needs to decide it and decides nothing. **OD-24** does not apply — this slice ships no screen. This plan decides none of them (§2.12).
- **Part VI tests owned / re-run:** **none**, either way (card). **§3.0.4 rows owned:** **none** (card). **Regression files created / appended:** **`tests/regression/legacy-077.test.ts` — appends, create-if-absent** (§3.7.3 first corollary: 9A has no fixed position in execution order, so it never "creates"; its task creates the file if 7A has not yet run, appends its own `describe` block either way, and asserts nothing about what other blocks exist). No other regression file is touched. **Import-validation tests for §5.1 items 1–5 and 12 live in `packages/importer/test/`, not `tests/regression/`** (card, explicit).
- **Shared namespaces this slice writes into:** document-type codes (§4.14) **none**. Account codes (§4.15) **none** — this slice seeds no pack, names no `account.code` in any policy, and resolves no account; the legacy account *codes* it reports are the customer's own strings and are never mapped here (9B maps them). Report codes (§4.16.1) **none** and `DatasetId` members (§4.16.2) **none** — the artefacts of this slice are files on disk, not `report_definition` rows; `packages/db/src/reports/datasets.ts` is not touched. `fixtures.ts` helpers (§4.17) **none** — §4.17 assigns 9A no helper and `packages/db/test/fixtures.ts` is not opened; shared test helpers (§4.17.1) **none added** — this package's fixture corpus loader lives at `packages/importer/test/support/corpus.ts` and is imported by no other workspace. The one shared literal space this slice writes into is the `ERR_*` space (§4.2.4): it adds **`ERR_IMPORT_SOURCE_UNREADABLE`** to `ERRORS`, a code that table already allocates to "Firebird reader (9A)" at status 500.
- **Never re-decide:** D1–D27 (spec:114–142); every name in the contracts document is frozen — a needed change goes to that document first.
- **Contracts version:** 2026-09-08 (§4.18 "extended 2026-09-08", Round 3). **Round 3 adds no 9A row** — it folds in 3A–9B's cross-slice amendments and nothing in it touches §4.13, §2.10's 9A card or hazard 3 — so every 9A statement in this header is read against Round 2, which is where this slice's rows landed (§4.18 rows for §2.9/§5.3, §3.11, §4.2.4 and the two §4.13.1 rows).

### Assumptions this plan rests on

Every assumption is stated here so a reviewer can reject it in one place instead of discovering it in a task.

1. **The Firebird version is unknown and this plan never guesses it** (hazard 3). `LegacyReader.firebirdVersion` is a **required non-empty string** in §4.13.1, so it must come from somewhere before a reader exists. **Task 3**'s `OdbcLegacyDriver.engineVersion` (`packages/importer/src/drivers/odbc.ts`) probes `rdb$get_context('SYSTEM', 'ENGINE_VERSION')` — available from Firebird 2.1 — and **Task 4**'s `createReader` **refuses to construct a reader** when that probe returns nothing and the operator has not passed `--firebird-version <string>`, raising `unreadable("the engine did not report a version; supply one (OD-17, ADR 0081)")`; ADR 0081 records the declared value as owner-supplied. (Task 2 builds only the predicate evaluator and the SQL renderer and reads no engine.) Nothing is inferred from the ODBC driver string, from a file header or from a `RDB$` column set.
2. **All three extraction methods terminate at one SQL connection, which is why the code is method-independent.** Part VII #5 asks "`gbak` vs ODBC vs direct file read". A `gbak` backup is restored into a throwaway Firebird instance and then read over a connection; a "direct file read" in practice means attaching the `.fdb` through a local Firebird server and reading it over a connection. The **method** changes the runbook (who takes the backup, on which machine, with what downtime) and is what ADR 0081 records; the **code** is the same `OdbcLegacyDriver` in all three cases. This plan therefore ships one live driver and does not stub two others.
3. **Reads are read-only and are asserted to be.** The driver never issues anything but `select`; `renderSelect`/`renderCount`/`renderMinMax` are the only three producers of statement text and each begins with the literal token `select`. Task 3's test asserts that property over the rendered text of every shape. Where the owner can arrange it, the ODBC DSN should be a read-only Firebird user — but the plan does not depend on it.
4. **`odbc` is a native module and its presence is not assumed at test time.** `packages/importer/src/drivers/odbc.ts` imports `odbc` **lazily**, inside `connectOdbc()`, so every test in this package — none of which connects — runs on a machine with no ODBC manager and no Firebird driver installed. The one test that would connect is skipped unless `LEGACY_ODBC_DSN` is set, the same shape §3.7.1 gives `tests/staging` under `STAGING_BASE_URL`.
5. **Firebird returns identifiers upper-cased and space-padded.** `RDB$RELATION_NAME` and `RDB$FIELD_NAME` are `CHAR(31)`/`CHAR(63)` and come back padded; every catalogue read wraps them in `trim(...)` in SQL and the driver upper-cases nothing further. Every table and column name in this plan's constants is written **upper-case** for that reason (`ACCTOTALS`, not `AccTotals`), while prose keeps the product's own casing.
6. **Legacy numerics never become JavaScript numbers.** spec:99 forbids a float holding money "anywhere, including in TypeScript", and an ODBC driver will happily hand back `NUMERIC(18,4)` as a `number`. The renderer therefore wraps every column the catalogue declares scaled-numeric or floating in `cast(<col> as varchar(40))`, and dates/timestamps in `cast(<col> as varchar(24))`, so values arrive as text and are parsed with `Decimal` when arithmetic is needed. `LegacyScalar` deliberately has **no `number` member**, and the driver raises `ERR_IMPORT_SOURCE_UNREADABLE` if a value of type `number` ever reaches it.
7. **`MatUnits.Exchange` is a float in the source and is reported as one.** LEGACY-066 says unit conversions were stored as floats and never applied. This slice does not convert them; it records the column's declared type as `float` in the profile so 9B knows to convert explicitly to a `Rational` (§4.2.1) and so the reconciliation report can flag a float-sourced figure.
8. **The recompute formulae are hypotheses until the live database confirms them.** The dossier gives the stored aggregates' *columns* (`AccTotals(Debit, Credit, AdminDebit, AdminCredit)`, `MatTotals(… InternalDebit/Credit, OrderDebit/Credit, TransferredDebit/Credit)`) but not which `Muniments` flags route a line into `Admin*`, `Internal*`, `Order*` or `Transferred*` — that logic lives in the 318 triggers and the fifteen unexamined DLLs (spec:71). This plan does **not** invent it. Every recompute is a row in `AGGREGATE_RULES` carrying its own `derivation` sentence and a `confidence` of `verified | hypothesis | not_derivable`, the report prints all three fields on every line, and the `not_derivable` rows are the explicit list the owner is asked to confirm. That is what "the difference on every recomputed figure is **explained**" (spec:2295) means operationally.
9. **The 460-table inventory is committed as data.** `packages/importer/src/legacy/modules.ts` holds the seventeen modules and their tables from the dossier's Appendix A. It is the instrument for Part VII #1 ("which modules are actually used"), it drives `ProfileReport.modulesInUse`, and — when no live catalogue is reachable — it is the allow-list identifiers are validated against. It is **data, not truth**: `profile` prefers the live `RDB$RELATIONS` list whenever one is available and reports tables present in the database but absent from the map, and vice versa.
10. **Never name a binding `db` or `sql` in `packages/importer/src/**`.** 0B's `no-bare-db` fires on `db.<anything>(` and on a template tagged `db` or `sql` **anywhere under `packages/*/src/`**, with no allow-list entry for this package. Connections are `conn`, statements are `text`, drivers are `driver`. This is a lint fact, not a style preference: `const db = await odbc.connect(dsn); db.query(...)` fails `bun run lint:rules`.
11. **`packages/importer/src/reader.ts` is on `no-sql-concat`'s `UNSAFE_ALLOW` list already** (0B shipped it as one of the three homes of `sql.unsafe`, §3.3). This plan **does not use it**: the ODBC driver calls `odbc`'s own parameterised `query(text, params)` and never `postgres.js`'s `.unsafe(`, and `reader.ts` renders no SQL at all. The allow-list entry is a permission, not an obligation; 0B's `legacy-036` assertion is a subset check and stays green.
12. **The untagged-template half of `no-sql-concat` has no allow-list**, so the renderer may not write ``const text = `select ${cols} from ${table}` ``. `renderSelect` pushes tokens into a `string[]` and returns `parts.join(" ")`; identifiers reaching that array have already been validated and quoted, and values never reach it at all. ADR 0082 records the reasoning.
13. **`Salaries` and `Standard` are separate legacy databases but usually one physical file per module set**, and `mpos*` is explicitly "a *deliberately separate* schema" (dossier §4.3). The CLI therefore takes `--dsn` for the main database and an optional `--mpos-dsn`; a `LegacyReader` is constructed per DSN and one is never asked to span two.
14. **Artefacts are customer data and are never committed.** Every command writes under `artefacts/legacy/<runId>/`, which Task 1 adds to `.gitignore`. The only committed corpus is the small synthetic one under `packages/importer/test/corpus/`, whose row values are invented for this repository and contain no customer data.

### Names this slice adds beyond the frozen registry

Contracts §4 says a plan "may add members only by amending this document". **The amendment has been made:** §4.18 Round 2 folds the cross-slice half of this list into §4.13.1 — the driver port `LegacyDriver` (with `constraints`), `LegacyConstraint`, the `LegacyPredicate` shape, `SelectSpec`, `LegacyScalar`/`Row`/`Column`/`ColumnKind`, `createReader(driver, declaredVersion?)`, `unreadable`, `profile(reader, opts?)` + `ProfileOptions`, `scope`/`ScopeReport`/`TableScope`/`DATE_COLUMN_CANDIDATES`, the artefact format (`ArtefactIndex`, `ArtefactEntry`, `ReportWriter`, `toCsv`), `RECONCILIATION_KINDS`, **and the barrel as the whole cross-slice surface** — plus the `LENDS`, `ALL_LEGACY_TABLES.size === 460`, `NEVER_READ` and `no-bare-db` facts. **So this list is now read in two halves.** Every name §4.13.1's barrel paragraph lists is a registry member and 9B may consume it; **every other name below is 9A-internal by that same paragraph** ("Everything else under `packages/importer/src/**` is internal to 9A … and no slice imports them") and is listed here for the reader of this plan, not as a pending amendment. `LegacyPredicate` belonged to 9A before either round — the §4 preamble assigns it.

**The port and the drivers (T1, T2, T3):** `LegacyScalar`, `LegacyRow`, `LegacyColumn`, `LegacyColumnKind`, `LegacyConstraint`, `SelectSpec`, `LegacyDriver` (with `constraints(table)`, added by T13), `unreadable`, `FixtureLegacyDriver`, `LegacyCorpus`, `OdbcLegacyDriver`, `connectOdbc`, `OdbcOptions`, `redactDsn`, `evaluatePredicate`, `predicateColumns`, `renderSelect`, `renderCount`, `renderMinMax`, `quoteIdent`, `CAST_WIDTH`, `RenderedStatement`.
**The map and the reader (T1, T4):** `LEGACY_MODULES`, `LegacyModule`, `ALL_LEGACY_TABLES`, `moduleOf`, `createReader`.
**Reports and artefacts (T3, T5, T6):** `scope`, `ScopeReport`, `TableScope`, `DATE_COLUMN_CANDIDATES`, `ReportWriter`, `toCsv`, `ArtefactEntry`, `ArtefactIndex`, `ProfileOptions`, `MPOS_MODULE_IDS`, `isMposTable`, `mposDecision`, `MposDecisionReport`.
**Reconciliation (T7–T11):** `RECONCILIATION_KINDS`, `AGGREGATE_RULES`, `AggregateRule`, `AggregateConfidence`, `aggregateDrift`, `hasColumns`, `READ_BATCH`, `unbalancedVouchers`, `SUSPENSE_QUESTION`, `orphans`, `ORPHAN_RULES`, `OrphanRule`, `nullPoison`, `NULL_POISON_TARGETS`, `NullPoisonTarget`, `duplicateAggregates`, `DUPLICATE_TARGETS`, `DuplicateTarget`, `employeeMapping`, `EMPLOYEE_MATCH_STRATEGIES`, `EmployeeMatchStrategy`, `EmployeeMatchStatus`, `normaliseLegacyName`.
**Catalogues and the snapshot (T12–T14):** `catalogueTemplates`, `classifyTemplate`, `templateStem`, `TEMPLATE_GROUP_RULES`, `TemplateCatalogue`, `TemplateEntry`, `TemplateGroup`, `answerOpenQuestions`, `CONSTRAINT_CLAIMS`, `ConstraintClaim`, `SALARIES_LIVENESS_TABLES`, `OpenQuestionReport`, `OpenQuestionAnswer`, `QuestionId`, `QuestionStatus`, `snapshot`, `planSnapshot`, `pseudonymise`, `PERSONAL_COLUMN_RULES`, `PersonalColumnRule`, `PersonalKind`, `NEVER_READ`, `SnapshotColumnPlan`, `SnapshotResult`.
**The CLI (T3, T14):** `parseArgs`, `CliArgs`, `main`.
**Test-tier only, imported by no other workspace (§4.17.1 adds nothing):** `loadCorpus`.
**And the environment name** **`LEGACY_ODBC_DSN`** (CLI-only, like `SUPABASE_SERVICE_ROLE_KEY`; it is never added to `containerSecrets()` and never reaches a container — §3.11), plus `LEGACY_MPOS_DSN` in T6's verify command, which is likewise CLI-only.

---

## Global Constraints

Copied verbatim from spec §0.2 (spec:97–106). Every task's requirements implicitly include this section.

**Never**, at any phase, for any reason:
- write to a ledger or movement table outside the posting service;
- represent money as a float, anywhere, including in TypeScript;
- build SQL by string concatenation (LEGACY-036/037/069);
- issue DDL from application code (LEGACY-053);
- disable an invariant, constraint or trigger "temporarily" (LEGACY-027, 041, 053);
- gate an audit write on any flag (LEGACY-030);
- hard-code a package version into a source file — the lockfile owns versions.

**Always**, for every new table: `tenant_id`, an RLS policy, `created_at`, a migration, and a test that a second tenant cannot see it. For every new endpoint: Zod schema, OpenAPI entry, idempotency on unsafe methods, and a tenant-isolation test. For every UI screen: verified in both text directions before merge.

Additionally binding on every task of this plan:

| Constraint | Exact value | Source |
|---|---|---|
| Money | no `number` ever holds a monetary value; legacy amounts cross every boundary as decimal **strings** and are computed with `decimal.js` | spec:2041, §3.7.5 `no-number-money` |
| Dates | legacy dates and timestamps are read as **strings** (`cast(... as varchar(24))`), never as `Date`; `ProfileReport.dateRange` is `{ min: string \| null; max: string \| null }` | spec:2039, §4.13.1 |
| SQL | never built by concatenation; the three homes of `sql.unsafe` are the migration runner, the pg-boss enqueue adapter and this package's Firebird reader — **and this plan uses none of them** | spec:100, §3.3, hazard 21 |
| Error codes | `ERR_<DOMAIN>_<REASON>` in one file; this slice adds exactly `ERR_IMPORT_SOURCE_UNREADABLE` (500) to `packages/contracts/src/errors.ts` | spec:2051, §4.2.4 |
| DDL | none. This slice creates no table and writes no migration; **0100 is reserved and stays unused** | spec:2057, §3.4.1 |
| Naming | TypeScript `camelCase` / `PascalCase`; legacy identifiers upper-case as Firebird stores them | spec:2045 |
| Logging | no `console` outside `packages/*/src/cli.ts`; the CLI is `packages/importer/src/cli.ts` and no lint override is widened | spec:2063, §3.2 |
| Commits | conventional, scope `importer`, subject `<type>(importer): <summary> [9A T<n>]`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` | §3.8 |
| Passwords | `Users.Password` and `Users.PIN` are **never read**, never profiled, never snapshotted — they are on a deny-list the snapshot test asserts | spec:2338, §5.1 #7, #11 |

---

## File Structure

Every path is written from the repository root. `T<n>` is the task that creates or last changes the file.

```
packages/importer/
├─ package.json                          @dulja/importer; deps decimal.js, odbc (no workspace dep)   T1
├─ tsconfig.json                         extends tsconfig.base.json                                 T1
├─ vitest.config.ts                      node environment, no Testcontainers                        T1
├─ src/
│  ├─ index.ts                           the §4.13.1 barrel, exactly     T4, T5, T6, T7, T11, T12, T13
│  ├─ cli.ts                             the one CLI (§3.2): scope profile reconcile
│  │                                     templates questions snapshot all
│  │                                                    T3, T5, T6, T7, T11, T12, T13, T14
│  ├─ reader.ts                          LegacyReader over a LegacyDriver (§4.13.1)                  T4
│  ├─ profile.ts                         profile(reader) → ProfileReport (§4.13.1)                   T5
│  ├─ scope.ts                           ScopeReport — row counts and date ranges per table          T3
│  ├─ artefacts.ts                       ReportWriter: JSON + CSV + index.json with sha256      T5, T12
│  ├─ snapshot.ts                        the anonymised staging snapshot (spec:2272)                T14
│  ├─ mpos.ts                            MPOS_MODULE_IDS/isMposTable/mposDecision — OD-16 input      T6
│  ├─ legacy/
│  │  ├─ types.ts                        LegacyScalar/Row/Column/Constraint, SelectSpec,
│  │  │                                  LegacyDriver (+ constraints() at T13)                 T1, T13
│  │  ├─ predicate.ts                    LegacyPredicate (T1) + evaluatePredicate (T2)           T1, T2
│  │  ├─ modules.ts                      LEGACY_MODULES — the 460-table map (dossier App. A)         T1
│  │  └─ aggregates.ts                   AGGREGATE_RULES — the declarative recompute table           T7
│  ├─ drivers/
│  │  ├─ fixture.ts                      FixtureLegacyDriver — the local equivalent (OD-17)  T1, T2, T13
│  │  ├─ sql.ts                          renderSelect/renderCount/renderMinMax/quoteIdent            T2
│  │  └─ odbc.ts                         OdbcLegacyDriver + connectOdbc + the version probe
│  │                                                                              T3, T12, T13
│  ├─ reconcile/
│  │  ├─ index.ts                        reconcile(reader, kind) (§4.13.1) — the dispatcher          T7
│  │  ├─ probe.ts                        hasColumns — the catalogue question LegacyReader
│  │  │                                  cannot ask                                                 T7
│  │  ├─ aggregate-drift.ts              §5.1 #1 — recompute from VouItems/BillItems                 T7
│  │  ├─ unbalanced-vouchers.ts          §5.1 #2 — detect and quantify (LEGACY-003)                     T8
│  │  ├─ orphans.ts                      §5.1 #3 — Job 82%, CostCentre 81% (LEGACY-073)                 T9
│  │  ├─ null-poison.ts                  §5.1 #4 — LEGACY-007, LEGACY-011                                 T10
│  │  ├─ duplicate-aggregates.ts         §5.1 #5 — MatObjects/MatQuantity (LEGACY-049)                 T10
│  │  └─ employee-mapping.ts             §5.1 #12 — Employees vs Accounts.IsEmployee                T11
│  └─ catalogue/
│     ├─ templates.ts                    §5.1 #9 — System.Reports blobs → TemplateCatalogue         T12
│     └─ questions.ts                    OD-27 — Part VII #6, #7, #8, #9, #13                       T13
└─ test/
   ├─ support/corpus.ts                  loadCorpus(name) → LegacyCorpus (+ constraints at T13) T1, T13
   ├─ corpus/base/catalog.json           the synthetic catalogue (tables, columns, keys)             T1
   ├─ corpus/base/*.json                 one file per legacy table, grown by T7, T9, T10, T11, T12   T1
   ├─ corpus/mpos/{catalog,POSTICKETS,POSENTRIES}.json    the second, POS corpus (OD-16)             T6
   ├─ corpus/questions/catalog.json      ten tables, one declared constraint (Part VII #6)          T13
   ├─ corpus/questions/*.json            ACCOUNTS MATOPENS MATUNITS MATOBJECTS EMPLOYEES
   │                                     PAYROLLS PAYITEMS TAXLAYERS SPRORDERS REPORTS              T13
   ├─ fixture-driver.test.ts                                                                         T1
   ├─ sql.test.ts                        the renderer and the predicate evaluator                    T2
   ├─ reader.test.ts                                                                                 T4
   ├─ profile.test.ts                                                                                T5
   ├─ scope.test.ts                                                                                  T3
   ├─ odbc.test.ts                       skipped unless LEGACY_ODBC_DSN is set                        T3
   ├─ mpos-scope.test.ts                 OD-16                                                        T6
   ├─ aggregate-drift.test.ts                                                                         T7
   ├─ unbalanced-vouchers.test.ts                                                                     T8
   ├─ orphans.test.ts                                                                                 T9
   ├─ null-poison.test.ts                                                                            T10
   ├─ duplicate-aggregates.test.ts                                                                   T10
   ├─ employee-mapping.test.ts                                                                       T11
   ├─ templates.test.ts                                                                              T12
   ├─ questions.test.ts                                                                              T13
   ├─ snapshot.test.ts                                                                               T14
   └─ cli.test.ts                        argument parsing and exit codes                             T14

docs/adr/0081-firebird-version-and-extraction-method.md                                              T3
docs/adr/0082-legacy-predicate-and-identifier-allow-list.md                                          T2
docs/adr/0083-legacy-artefact-format-and-anonymisation.md                                            T5
docs/runbooks/legacy-extraction.md       how the owner runs the seven commands, in order            T14

MODIFIED (each an additive edit; no existing behaviour changes)
packages/contracts/src/errors.ts         + ERR_IMPORT_SOURCE_UNREADABLE (§4.2.4 allocates it)        T4
package.json                             + "legacy" script                                           T1
.gitignore                               + artefacts/                                                T1
tests/regression/legacy-077.test.ts         append, create-if-absent (§3.7.3 first corollary)          T12
tests/package.json                       + "@dulja/importer": "workspace:*" (one key)               T12
docs/adr/0083-…-anonymisation.md         + the correction-C4 amendment under Consequences           T14

CORRECTED IN A LATER TASK (each an exact diff, listed in Self-Review; nothing is rewritten)
packages/importer/test/fixture-driver.test.ts   C1 — growth-proof table list                         T7
packages/importer/test/scope.test.ts     C1 — growth-proof table, row and missing counts             T7
packages/importer/test/reader.test.ts    C1 — growth-proof table list                                T7
packages/importer/test/profile.test.ts   C1 — growth-proof table list                                T7
packages/importer/test/mpos-scope.test.ts  C1 — the filter asserted as a difference, not a list      T7
packages/importer/test/profile.test.ts   ACCOUNTS 3→5 rows; salaries false→true                     T11
packages/importer/test/scope.test.ts     ACCOUNTS 3→5 rows                                          T11
packages/importer/test/aggregate-drift.test.ts  `drifting` 1→2 once ACCTOTALS.CREDIT is nulled      T10
packages/importer/src/drivers/odbc.ts    C2 — a blob crosses the seam as base64, not String(buf)    T12
packages/importer/src/artefacts.ts       C2 — mkdirSync the artefact's own directory                T12
packages/importer/src/cli.ts             C5 — `main` exported, exit guarded by import.meta.main     T14
```

**Two corrections the earlier revision deferred are now written correctly where the code is first typed**, so
nothing is corrected later: the three `odbc.ts` catalogue statements are single unbroken template literals in
**T3 Step 3** (they were joined with `+`, which spec:100 forbids outright), and `cli.ts`'s fixture-corpus path
is resolved from `import.meta.url` with `openDriver` called inside `main`'s `try` in **T3 Step 5** (the root
`legacy` script runs with cwd = `packages/importer`, so a cwd-relative corpus path never resolved at all). The
Self-Review records both.

**What is deliberately absent.** No `packages/db/migrations/**` file (0100 stays unused). No route module, no `PROBES` entry, no permission code, no `document_type`, no `account`, no `report_definition`, no `DatasetId`, no `fixtures.ts` helper, no pg-boss job — `admin.import.run` is **9B's** entry in the closed `JOBS` registry (§4.2.6) and this slice does not add it. No React component: 9A has no screen, so OD-24 does not apply.

---

### Task 1: The package, the driver port, and the fixture driver

**Files:**
- Create: `packages/importer/package.json`, `packages/importer/tsconfig.json`, `packages/importer/vitest.config.ts`, `packages/importer/src/legacy/types.ts`, `packages/importer/src/legacy/modules.ts`, `packages/importer/src/drivers/fixture.ts`, `packages/importer/test/support/corpus.ts`, `packages/importer/test/corpus/base/catalog.json`, `packages/importer/test/corpus/base/ACCOUNTS.json`, `packages/importer/test/corpus/base/VOUCHERS.json`, `packages/importer/test/corpus/base/VOUITEMS.json`
- Modify: `package.json` (root — one script), `.gitignore`
- Test: `packages/importer/test/fixture-driver.test.ts`

**Interfaces:**
- Consumes: nothing from another slice. The root scripts `bun run typecheck` and `bun run test` (turbo, plan0A:259–266) pick the workspace up automatically because root `workspaces` already contains `packages/*`.
- Produces:
  ```ts
  // packages/importer/src/legacy/types.ts
  export type LegacyScalar = string | boolean | null;                 // deliberately NO number — spec:99
  export type LegacyRow = Readonly<Record<string, LegacyScalar>>;
  export type LegacyColumnKind = "text" | "decimal" | "float" | "integer" | "date" | "timestamp" | "time" | "blob" | "other";
  export interface LegacyColumn { readonly name: string; readonly kind: LegacyColumnKind; readonly scale: number; readonly nullable: boolean }
  export interface SelectSpec { readonly table: string; readonly columns: readonly string[]; readonly where?: LegacyPredicate; readonly orderBy?: readonly string[] }
  export interface LegacyDriver {
    readonly kind: "odbc" | "fixture";
    readonly source: string;                                          // redacted, for the artefact header
    engineVersion(): Promise<string | null>;
    tables(): Promise<string[]>;
    columns(table: string): Promise<LegacyColumn[]>;
    keyColumns(table: string): Promise<string[]>;
    count(table: string, where?: LegacyPredicate): Promise<number>;
    minMax(table: string, column: string): Promise<{ min: string | null; max: string | null }>;
    cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]>;
    close(): Promise<void>;
  }
  // packages/importer/src/legacy/modules.ts
  export interface LegacyModule { readonly id: string; readonly database: string; readonly disposition: "core" | "pos" | "vertical" | "customisation" | "reporting" | "root"; readonly tables: readonly string[] }
  export const LEGACY_MODULES: readonly LegacyModule[];
  export function moduleOf(table: string): LegacyModule | undefined;
  export const ALL_LEGACY_TABLES: ReadonlySet<string>;
  // packages/importer/src/drivers/fixture.ts
  export interface LegacyCorpus { readonly engineVersion: string | null; readonly tables: Readonly<Record<string, { columns: readonly LegacyColumn[]; keyColumns: readonly string[]; rows: readonly LegacyRow[] }>> }
  export class FixtureLegacyDriver implements LegacyDriver { constructor(corpus: LegacyCorpus, source?: string) }
  // packages/importer/test/support/corpus.ts
  export function loadCorpus(name?: string): LegacyCorpus;            // default "base"
  ```
  `LegacyPredicate` is declared **here, in Step 6**; Task 1's `SelectSpec.where` and `LegacyDriver.count` reference it through `import type { LegacyPredicate } from "./predicate"`, and Step 6 creates `predicate.ts` containing **only** the type alias so `types.ts` compiles; **Task 2** adds `evaluatePredicate` and `predicateColumns` to the same file.

- [ ] **Step 1: Scaffold the workspace**

`packages/importer/package.json`:

```json
{
  "name": "@dulja/importer",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "node ../../node_modules/vitest/vitest.mjs run"
  }
}
```

No `"build"`: this package emits no `dist/` (§3.1 — TypeScript source is exported directly unless the package is a deployable). No version numbers here or anywhere else — dependencies are added with `bun add` in Step 2 and the lockfile owns their versions (spec:104).

`packages/importer/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`packages/importer/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// No Testcontainers in this package: nothing here opens a PostgreSQL connection, so the 60 s/180 s timeouts
// contracts §3.7.1 gives the DB-backed suites would only slow a failing assertion down.
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"], testTimeout: 10_000 },
});
```

- [ ] **Step 2: Install this package's two dependencies**

```bash
bun add --cwd packages/importer decimal.js odbc
```

Expected: `packages/importer/package.json` gains a `dependencies` block with exactly those two names and `bun.lock` is updated. `decimal.js` gives exact decimal arithmetic for the recomputations of Tasks 7–11; `odbc` is the live Firebird connection **Task 3** builds `OdbcLegacyDriver` on, and it is imported **lazily** (inside `connectOdbc()`) so its native binding is never loaded by a test.

**No workspace dependency, and `@dulja/contracts` in particular is not one.** §4.13.1 states that this package "has no HTTP surface and may not import `@dulja/contracts`' error class (§3.1)", and no file written by any of this plan's fourteen tasks imports a value or a type from it: `unreadable()` (Step 7) returns a plain `Error` carrying the token `ERR_IMPORT_SOURCE_UNREADABLE`. §3.1's row `"packages/importer": ["@dulja/domain", "@dulja/db", "@dulja/contracts"]` is `dependency-rule`'s **allow-list of permitted imports**, not a list of required manifest entries, so declaring an unused one would only invite an executor to use it. Task 4 Step 5 *edits* `packages/contracts/src/errors.ts` to add the code's registry row — a change to that package, made from the repository root, needing no dependency edge in this direction.

- [ ] **Step 3: Root `package.json` gains one script, `.gitignore` one line**

Add to the root `"scripts"` block, next to `db:migrate`:

```json
    "legacy": "bun run --cwd packages/importer src/cli.ts",
```

Add to `.gitignore`:

```gitignore
# Legacy extraction artefacts hold customer data and are never committed (plan 9A).
artefacts/
```

Root `workspaces` is **not** edited: 0B already set it to `["packages/*", "apps/*", "tests"]` and 0C appends `"infra"`; `packages/importer` matches `packages/*`.

- [ ] **Step 4: Write the failing test**

`packages/importer/test/fixture-driver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { ALL_LEGACY_TABLES, LEGACY_MODULES, moduleOf } from "../src/legacy/modules";
import { loadCorpus } from "./support/corpus";

describe("FixtureLegacyDriver — the local equivalent every task is developed against (OD-17 default)", () => {
  it("answers the catalogue questions from the committed corpus", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus());
    expect(driver.kind).toBe("fixture");
    expect(await driver.engineVersion()).toBe("WI-V2.5.9.27139 Firebird 2.5");
    expect(await driver.tables()).toEqual(["ACCOUNTS", "VOUCHERS", "VOUITEMS"]);
    expect(await driver.keyColumns("VOUITEMS")).toEqual(["SITE", "ID", "ROW"]);
    const columns = await driver.columns("VOUITEMS");
    expect(columns.find((c) => c.name === "DEBIT")).toEqual({ name: "DEBIT", kind: "decimal", scale: 4, nullable: true });
    expect(columns.find((c) => c.name === "ACCOUNT")).toEqual({ name: "ACCOUNT", kind: "integer", scale: 0, nullable: true });
  });

  it("counts, ranges and pages without ever producing a number for a money column", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus());
    expect(await driver.count("VOUITEMS")).toBe(4);
    expect(await driver.minMax("VOUCHERS", "DATE")).toEqual({ min: "2024-01-15", max: "2024-03-02" });

    const batches: string[][] = [];
    for await (const rows of driver.cursor({ table: "VOUITEMS", columns: ["ID", "DEBIT"], orderBy: ["SITE", "ID", "ROW"] }, 3)) {
      batches.push(rows.map((r) => `${String(r.ID)}:${String(r.DEBIT)}`));
      for (const row of rows) expect(typeof row.DEBIT).not.toBe("number");
    }
    expect(batches).toEqual([["1:100.0000", "1:0.0000", "2:250.0000"], ["2:250.0000"]]);
  });

  it("refuses a table it does not hold, naming it", async () => {
    const driver = new FixtureLegacyDriver(loadCorpus());
    await expect(driver.columns("PAYROLLS")).rejects.toThrow(/ERR_IMPORT_SOURCE_UNREADABLE: table PAYROLLS is not in the corpus/);
  });
});

describe("LEGACY_MODULES — the 460-table map that answers Part VII #1", () => {
  it("covers the seventeen shipped databases and routes a table to its module", () => {
    expect(LEGACY_MODULES).toHaveLength(17);
    expect(moduleOf("VOUITEMS")?.id).toBe("standard");
    expect(moduleOf("POSTICKETS")?.id).toBe("mpossystem");
    expect(moduleOf("PAYROLLS")?.id).toBe("salaries");
    expect(moduleOf("SPRORDERS")?.disposition).toBe("customisation");
    expect(moduleOf("NOSUCHTABLE")).toBeUndefined();
    // The dossier's own totals: 460 tables across the seventeen databases (analysis §4).
    expect(ALL_LEGACY_TABLES.size).toBe(460);
  });
});
```

- [ ] **Step 5: Run it and see it fail**

Run: `bun run --cwd packages/importer test`
Expected: FAIL — `Cannot find module '../src/drivers/fixture'`.

- [ ] **Step 6: Write `packages/importer/src/legacy/predicate.ts` (the type only)**

```ts
/**
 * The `where` a caller may ask the legacy reader for (contracts §4.13.1: "a typed structure, never SQL text").
 * 9A defines it; 9B consumes it through `LegacyReader.read` and never redefines it (§4 preamble). Values are
 * always bound as parameters, so nothing a caller passes can become statement text. ADR 0082.
 */
export type LegacyPredicate =
  | { readonly op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; readonly column: string; readonly value: string | boolean | null }
  | { readonly op: "in"; readonly column: string; readonly values: readonly (string | boolean | null)[] }
  | { readonly op: "between"; readonly column: string; readonly from: string; readonly to: string }
  | { readonly op: "is_null" | "is_not_null"; readonly column: string }
  | { readonly op: "and" | "or"; readonly operands: readonly LegacyPredicate[] };
```

- [ ] **Step 7: Write `packages/importer/src/legacy/types.ts`**

```ts
import type { LegacyPredicate } from "./predicate";

/**
 * A value read out of the legacy database. There is deliberately **no `number` member**: spec:99 forbids a
 * float holding money "anywhere, including in TypeScript", and an ODBC driver hands NUMERIC(18,4) back as a
 * JavaScript number unless the query casts it. Every scaled-numeric and floating column is cast to varchar in
 * the renderer (Task 2), so amounts arrive as exact decimal text and are computed with `Decimal`.
 */
export type LegacyScalar = string | boolean | null;
export type LegacyRow = Readonly<Record<string, LegacyScalar>>;

/** How a column's declared Firebird type is classified, from RDB$FIELDS (Task 3). */
export type LegacyColumnKind =
  | "text" | "decimal" | "float" | "integer" | "date" | "timestamp" | "time" | "blob" | "other";

export interface LegacyColumn {
  readonly name: string;          // upper-case, trimmed — Firebird pads RDB$FIELD_NAME to CHAR(63)
  readonly kind: LegacyColumnKind;
  readonly scale: number;         // digits after the point for `decimal`; 0 otherwise
  readonly nullable: boolean;
}

/** A read, described structurally. The driver — not the caller — turns this into text (Task 2). */
export interface SelectSpec {
  readonly table: string;
  readonly columns: readonly string[];      // empty means every column the catalogue declares
  readonly where?: LegacyPredicate;
  readonly orderBy?: readonly string[];
}

/**
 * The one seam that knows a database exists. Two implementations ship in 9A: `OdbcLegacyDriver` (live, ADR
 * 0081) and `FixtureLegacyDriver` (the corpus, and the local equivalent for OD-17). Everything above this
 * interface is a pure function of rows and is unit-tested with no database at all.
 */
export interface LegacyDriver {
  readonly kind: "odbc" | "fixture";
  /** A redacted description of the connection, printed in every artefact header. Never a password. */
  readonly source: string;
  engineVersion(): Promise<string | null>;
  tables(): Promise<string[]>;
  columns(table: string): Promise<LegacyColumn[]>;
  keyColumns(table: string): Promise<string[]>;
  count(table: string, where?: LegacyPredicate): Promise<number>;
  minMax(table: string, column: string): Promise<{ min: string | null; max: string | null }>;
  cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]>;
  close(): Promise<void>;
}

/** The one message shape this package raises. The code is contracts §4.2.4's, allocated to "Firebird reader (9A)". */
export function unreadable(detail: string): Error {
  return new Error(`ERR_IMPORT_SOURCE_UNREADABLE: ${detail}`);
}
```

`unreadable()` returns a plain `Error` carrying the token, not an `AppError`: this package has no HTTP surface, and the CLI maps the token to exit code 3 (Task 3). Task 4 wires the same token into `packages/contracts/src/errors.ts` so the `error-codes` build check sees a raise site (§4.2.4).

- [ ] **Step 8: Write `packages/importer/src/legacy/modules.ts`**

The table lists are the dossier's Appendix A, upper-cased (assumption 5). Keep them one module per entry, in the dossier's own order, so a reviewer can diff them against the source.

```ts
export interface LegacyModule {
  readonly id: string;
  readonly database: string;
  readonly disposition: "core" | "pos" | "vertical" | "customisation" | "reporting" | "root";
  readonly tables: readonly string[];
}

/**
 * The shipped surface: 460 tables across seventeen databases (analysis §4, Appendix A). This is the instrument
 * for Part VII #1 — "460 tables is the shipped surface, not the used surface. Run row counts per table against
 * the live database" (spec:2465) — and the allow-list identifiers are validated against when no live catalogue
 * is reachable (Task 3). It is data, not truth: `profile` prefers the live RDB$RELATIONS list and reports the
 * symmetric difference in both directions (Task 5).
 */
export const LEGACY_MODULES: readonly LegacyModule[] = [
  { id: "types", database: "Types", disposition: "root", tables: ["FLAGS"] },
  { id: "system", database: "System", disposition: "core", tables: [
    "OPTIONS", "PROFILES", "REPORTS", "KINDS", "LEVELS", "SIGNS", "SITES", "NUMBERS", "REPLICATIONS",
    "DEPARTMENTS", "DEPTLINKS", "LOCATIONS", "USERS", "REGIONS", "CARRIERS", "JOBS", "COSTCENTRES",
    "ELEMENTS", "MUNIMENTS", "DESCRIPTORS", "DESCVALUES", "DESCMUNIMENTS", "TAXMUNIMENTS", "FIXES",
    "POINTS", "TERMINALS", "LOGS", "POINTLOGS", "USERPOINTS"] },
  { id: "standard", database: "Standard", disposition: "core", tables: [
    "CURRENCIES", "CURHISTORY", "PRICES", "GRADES", "ACCTYPES", "TAXCODES", "PAYTERMS", "PRICEGROUPS",
    "ACCOUNTS", "DRAFTACCOUNTS", "VISITREASONS", "VISITS", "AUDITS", "JOURNAL", "JURDESCRIPTORS",
    "JURTAXINFO", "JURREFINFO", "TAXLOGS", "ACCCOSTCENTRES", "GRANTS", "SUBACCOUNTS", "ACCSUBITEMS",
    "ACCDESCRIPTORS", "DACDESCRIPTORS", "PARTNERS", "ACCGROUPS", "ACCLISTS", "ACCSHEETS", "ACCOBJECTS",
    "ACCTOTALS", "ACCCURTOTALS", "DEPTACCOUNTS", "ACCINFO", "BATCHES", "BATDESCRIPTORS", "INCOMECALLS",
    "ACTIVITIES", "VOUCHERS", "VOUITEMS", "WAREHOUSES", "ACTIVITYITEMS", "PACKS", "MATCONSISTS",
    "MATCLASSES", "UNITS", "MATGROUPS", "MATERIALS", "MATDESCRIPTORS", "MATLISTS", "MATTOTALS",
    "MATCOSTS", "MATSTATUS", "MATOPENS", "MATOBJECTS", "MATUNITS", "MATPRICES", "MATBATCHES",
    "MATJOBPRICES", "MATJOBCOSTS", "MATBATCHCOSTS", "DEPTMATERIALS", "PRICELISTS", "BATINFO",
    "QUALIFIES", "ACCPRICES", "ACCCOMMISSIONS", "CATEGORIES", "MATINFO", "VARIETIES", "SUBITEMS",
    "INTERNALITEMS", "MATVARIETIES", "MATBARCODES", "MATQUANTITY", "MATLIMITS", "BILLS", "BILLINFO",
    "BILLITEMS", "BILLDETAILS", "TAXITEMS", "MODELS", "BILLMODELS", "VOUMODELS", "PREPAREPACKAGE",
    "WORKFLOW", "CHAINS", "CHAINITEMS", "SERIALS", "SERSTATES", "SERACTIVATES", "SERACTIVATEITEMS",
    "MSGLOGS", "OFFERS", "OFFERITEMS", "ACCSCORES", "DROPSCORES", "ROUTES", "ROUTEITEMS", "DEPTJOBS",
    "DEPTWAREHOUSES", "DEPTCOSTCENTRES", "DEPTSUBACCOUNTS", "BOMS", "BOMEXPENSES", "BOMITEMS",
    "ACCREFINFO", "TAXPROFILES"] },
  { id: "mposstandard", database: "mposStandard", disposition: "pos", tables: [
    "POSDESCRIPTORS", "POSREGIONS", "POSEXPANSIONS", "POSPRICES", "POSGRADES", "POSACCOUNTS",
    "POSACCINFO", "POSACCDESCRIPTORS", "POSQUALIFIES", "POSWAREHOUSES", "POSGROUPS", "POSVARIETIES",
    "POSCATEGORIES", "POSUNITS", "POSMATERIALS", "POSSUBITEMS", "POSINTERNALITEMS", "POSMATUNITS",
    "POSMATVARIETIES", "POSHOTMATERIALS", "POSCURRENCIES", "POSCURPARTS", "POSBARCODES", "POSSUITES",
    "POSTABLES", "POSVISITS", "POSENTRIES", "POSENTRYITEMS", "POSTAXITEMS", "POSPAYMENTS",
    "POSTABLESTATES", "POSTABLEINFO", "POSMATTOTALS", "POSACCTOTALS", "POSMATWAREHOUSES",
    "POSEMPLOYEEMEALS", "POSACCPRICES", "POSSERIALSTATES", "POSENTRYTAXINFO", "POSTAXLOGS", "POSOFFERS",
    "POSOFFERITEMS", "POSMODIFIERGROUPS", "POSMODIFIERITEMS", "POSMATMODIFIERS", "POSMODIFIERS",
    "POSACCOFFERS", "POSMATPRICES", "POSPRICEGROUPS", "POSPRICELISTS", "POSENTRYLOGS"] },
  { id: "mpossystem", database: "mposSystem", disposition: "pos", tables: [
    "POSCENTERS", "POSOPTIONS", "POSPROFILES", "POSNUMBERS", "POSPOINTS", "POSUSERGROUPS", "POSUSERS",
    "POSMETHODS", "POSPAYWAYS", "POSTAXTYPES", "POSPARCELS", "POSSUMMARIES", "POSENTRYTICKETS",
    "POSTICKETS", "POSACTIVETICKETS", "POSLOGS", "POSLOCKS", "POSENROLLS"] },
  { id: "hospitals", database: "Hospitals", disposition: "vertical", tables: [
    "LABUNITS", "HHSTATUS", "HSPUNITS", "MDCNFORMAT", "MCDNUSAG", "MEDICINES", "CLINICMEDICINES",
    "PATIENTS", "HHCATEGORIES", "TREATMENTS", "HHSTATUSLINK", "ANLTEMPLATES", "ANLITEMS",
    "ANLLISTVALUES", "ANLITEMSLINK", "ANLTLISTS", "TRTDEPTLINKS", "MICROBES", "MANTIBIOTICS",
    "HSPLISTVALUES", "TREATMENTSLINKS", "CTEMPLATES", "TREATCLASSES", "BEDS", "CLINICDOCTORS",
    "CLINICHOLIDAYS", "SHIFTSCLINIC", "ANALYSISRANGE", "ANALYSISMATS", "PRERESERVATION", "PRERSVITEMS",
    "RSVDETAILS", "HHSEASONS", "GSTNUMBERS", "VISITBOOK", "BOOKINFO", "RECIPES", "VISITROVES",
    "VISITITEMS", "ANALYSISVALUES", "TESTHISTORY", "VISITINFO", "HSPCOSTPAID", "ICOMPANIES",
    "UINSUREPRICES", "DINSUREPRICES", "ROOMUSERS", "VISITORDERS", "ORDERSSRVITEMS", "ORDERSMATITEMS"] },
  { id: "academy", database: "Academy", disposition: "vertical", tables: [
    "ACADEMIES", "ACADWORKING", "TEACHERS", "TEACHERWORKING", "STUDENTS", "CERTIFICATES",
    "SPECIALIZATIONS", "COURSES", "COURSEDETAILS", "COURSEPARTS_1", "SPECCOURSES", "TEACHERCOURSES",
    "ACADCLASSES", "CLASSESFORMS", "SEMESTERS", "CLASSFORMSEMESTER", "CLASSFORMCOURSE",
    "CLASSFORMCOURSEPR", "ACADEMICYEAR", "CYCLES", "CYCLEWORKING", "SCHOOLROOM", "CYCLECOURSESPRICING",
    "CYCLEPRICING", "WORKINGSCHEDULE", "WORKINGSCHEDITEMS", "LESSONS", "PRESENCE", "ACADSERVICES",
    "ACADSERVICESPRICING", "STUDENTENROLLS", "STUDENTCOURSES", "STUDENTSERVICES", "DRIVERPRESENCE",
    "GRADEENROLLS", "STUDENTGRADES", "MESSAGETEMPLATE", "MESSAGEEVENTS", "TEACHERATTEND",
    "TEACHERATTENDITEMS", "TEACHERPAYROLLS", "TEACHERPAYITEMS", "STUDENTSACADEMY", "STUDENTFINALSCORE"] },
  { id: "services", database: "Services", disposition: "vertical", tables: [
    "SERVICES", "SRVCLASSES", "SRVBALANCE", "SRVIMPLEMENTATION", "SRVTOTALS", "SRVDEPTLINKS",
    "CONTRACTINFO", "SRVITEMS", "SRVSTATUS", "SRVDUES", "DUESITEMS", "SRVSTOPS", "SRVSOLDS",
    "AIRPORTS", "AIRPORTSSUPPLIERS", "AIRCRAFTS", "NOREFORMS", "TRIPREASONS", "MNTINFO", "MAINTENANCE",
    "SRVDESCRIPTORS", "SRVDETAILS", "MUNIMENTDESCS", "DEPTDESCS", "SRVLISTVALUES", "MNTTRACKS",
    "BILLDESCRIPTORS", "MAINTENACEMATS", "SKYAIRCRAFTITMES", "SKYROUTES", "SKYSRVITEMS", "MNTSRVITEMS",
    "MNTBILLITEMS", "SRVDOCUMENTS", "FLOORS", "ROOMS", "CNTBILLITEMS", "CNTSERIALS"] },
  { id: "salaries", database: "Salaries", disposition: "core", tables: [
    "ORGANICS", "ORGANICINFO", "SHIFTS", "SHIFTITEMS", "SHIFTGROUPS", "SHIFTLISTS", "PERSONNELS",
    "EMPGROUPS", "EMPCLASSES", "EMPLOYEES", "EMPHOLIDAYS", "EMPADDITIONALS", "EMPHISTORY", "HOLIDAYS",
    "ATTENDS", "ATTENDITEMS", "ATTENDFILES", "ATTENDCLOCKS", "TAXLAYERS", "INCIDENTSTUBS", "INCIDENTS",
    "INCIDENTINFO", "PAYROLLS", "PAYITEMS", "PAYINCIDENTS", "ENROLLSTUBS", "ENROLLS", "ENROLLRECORDS",
    "ALLOTMENTS", "VACATIONS", "VACITEMS", "VACLAYERS", "EMPVACATIONS", "EMPPRODUCTIONS", "PROMOTIONS",
    "PROMOTIONITEMS"] },
  { id: "archives", database: "Archives", disposition: "vertical", tables: [
    "RCVGROUPS", "RCVKINDS", "RCVDESCRIPTORS", "RCVKINDLINKS", "RCVDEPTDESCS", "RCVKINDDESCS",
    "RCVLISTVALUES", "RCVDOCUMENTS", "DOCDEPARTMENTS", "RCVVERSIONS", "DOCUMENTINFO", "RCVTIMER",
    "RCVDELETEDATTACHMENTS", "ATTACHMENTSINFO", "RCVATTACHMENTS", "RCVICONS", "RCVMESSAGES",
    "RCVTRACKS", "RCVLINKS", "RCVDESCKTOP", "RCVDOCDESCRIPTORS", "RCVTEMPLATE", "TASKS", "TASKITEMS",
    "DEFARCHIVE"] },
  { id: "payments", database: "Payments", disposition: "core", tables: [
    "PAYMASTERS", "PAYMENTS", "PAYMENTINFO", "PAYDETAILS", "PAYMODELS", "PAYCOMMISSIONS",
    "COMMISSIONLAYERS", "DEALERS", "CHOPPARSERS", "INVENTORYLIST", "INVITEMS", "HASHFILES", "BILLBINDS",
    "MATCONSIGNMENTS", "TAXRETURNS", "TAXRETURNITEMS", "CURRECONCILES", "CURRECONCILEITEMS",
    "REWARDMEMBERS", "REWARDS", "REWARDITEMS", "REWARDLAYERS"] },
  { id: "special", database: "Special", disposition: "customisation", tables: [
    "SPRORDERS", "SPRORDITEMS", "SPRWEEKS", "SPRWEEKITEMS", "SPRACCMATGROUPS", "SPRSTOCKSLICES",
    "SPRRSTSITEMS", "SPRPACKSLICES", "SPRACCTARGETS", "SPRVISITINFO", "SPRVISITINFOITEMS"] },
  { id: "fixedassets", database: "FixedAssets", disposition: "vertical", tables: [
    "ASSETTYPES", "ASSETS", "ASSETENTRIES", "ASSETENTRYITEMS", "ASSETSERIALS", "ASSETENTRIESERIALS",
    "ASSETDEPRITEMS", "DESCASSETTYPES", "ASSETDESCRIPTORS", "ASSETINFO"] },
  { id: "orders", database: "Orders", disposition: "core", tables: [
    "ORDERS", "ORDERDETAILS", "ORDERITEMS", "ORDERINFO", "ORDERSHIP", "DELIVERYDETAILS", "EXPENSEITEMS",
    "ACCCONTRACTS", "ACCCONTRACTITEMS", "CONTRACTHISTORY"] },
  { id: "additions", database: "Additions", disposition: "core", tables: ["ACCBUDGET", "SUBACCBUDGET", "MATEQUIVALENT"] },
  { id: "appointments", database: "Appointments", disposition: "vertical", tables: ["PRIORITY", "APPOINTMENT", "APPTDESCRIPTORS"] },
  { id: "tcbreports", database: "tcbReports", disposition: "reporting", tables: ["_ACCBALANCES", "_FACING"] },
];

const INDEX: ReadonlyMap<string, LegacyModule> = new Map(
  LEGACY_MODULES.flatMap((m) => m.tables.map((t) => [t, m] as const)),
);

export const ALL_LEGACY_TABLES: ReadonlySet<string> = new Set(INDEX.keys());

export function moduleOf(table: string): LegacyModule | undefined {
  return INDEX.get(table.trim().toUpperCase());
}
```

**If the counts do not add up**, the assertion in Step 4 (`ALL_LEGACY_TABLES.size === 460`) fails and names the shortfall. Fix the *data* against `docs/spec/legacy-system-analysis.md` Appendix A — never the assertion. The per-module totals the dossier gives are: Types 1, System 29, Standard 107, mposStandard 51, mposSystem 18, Hospitals 50, Academy 44, Services 38, Salaries 36, Archives 25, Payments 22, Special 11, FixedAssets 10, Orders 10, Additions 3, Appointments 3, tcbReports 2 = 460.

- [ ] **Step 9: Write the corpus and its loader**

`packages/importer/test/corpus/base/catalog.json` — the shape `LegacyCorpus` expects, minus the rows:

```json
{
  "engineVersion": "WI-V2.5.9.27139 Firebird 2.5",
  "tables": {
    "ACCOUNTS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "CODE", "kind": "text", "scale": 0, "nullable": true },
        { "name": "NAME", "kind": "text", "scale": 0, "nullable": true },
        { "name": "ISEMPLOYEE", "kind": "integer", "scale": 0, "nullable": true }
      ]
    },
    "VOUCHERS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "DATE", "kind": "date", "scale": 0, "nullable": true },
        { "name": "MUNIMENT", "kind": "integer", "scale": 0, "nullable": true }
      ]
    },
    "VOUITEMS": {
      "keyColumns": ["SITE", "ID", "ROW"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ROW", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ACCOUNT", "kind": "integer", "scale": 0, "nullable": true },
        { "name": "JOB", "kind": "integer", "scale": 0, "nullable": true },
        { "name": "COSTCENTRE", "kind": "integer", "scale": 0, "nullable": true },
        { "name": "DEBIT", "kind": "decimal", "scale": 4, "nullable": true },
        { "name": "CREDIT", "kind": "decimal", "scale": 4, "nullable": true }
      ]
    }
  }
}
```

`packages/importer/test/corpus/base/ACCOUNTS.json`:

```json
[
  { "SITE": "1", "ID": "10", "CODE": "1000", "NAME": "Cash", "ISEMPLOYEE": "0" },
  { "SITE": "1", "ID": "11", "CODE": "4000", "NAME": "Sales", "ISEMPLOYEE": "0" },
  { "SITE": "1", "ID": "12", "CODE": "2100", "NAME": "Ali Hassan", "ISEMPLOYEE": "1" }
]
```

`packages/importer/test/corpus/base/VOUCHERS.json`:

```json
[
  { "SITE": "1", "ID": "1", "DATE": "2024-01-15", "MUNIMENT": "3" },
  { "SITE": "1", "ID": "2", "DATE": "2024-03-02", "MUNIMENT": "3" }
]
```

`packages/importer/test/corpus/base/VOUITEMS.json`:

```json
[
  { "SITE": "1", "ID": "1", "ROW": "1", "ACCOUNT": "10", "JOB": "0", "COSTCENTRE": null, "DEBIT": "100.0000", "CREDIT": "0.0000" },
  { "SITE": "1", "ID": "1", "ROW": "2", "ACCOUNT": "11", "JOB": "0", "COSTCENTRE": null, "DEBIT": "0.0000", "CREDIT": "100.0000" },
  { "SITE": "1", "ID": "2", "ROW": "1", "ACCOUNT": "10", "JOB": "99", "COSTCENTRE": null, "DEBIT": "250.0000", "CREDIT": "0.0000" },
  { "SITE": "1", "ID": "2", "ROW": "2", "ACCOUNT": "11", "JOB": "0", "COSTCENTRE": null, "DEBIT": "250.0000", "CREDIT": "0.0000" }
]
```

Voucher 2 is deliberately unbalanced (500 debit, 0 credit) and carries `JOB = 99`, which no `JOBS` row resolves — the two defects Tasks 8 and 9 detect. Every value is a **string** even where the column is an integer, because that is what the ODBC path produces after the cast (assumption 6) and the fixture must not be easier to satisfy than the real thing.

`packages/importer/test/support/corpus.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LegacyCorpus } from "../../src/drivers/fixture";
import type { LegacyColumn, LegacyRow } from "../../src/legacy/types";

interface CatalogFile { engineVersion: string | null; tables: Record<string, { keyColumns: string[]; columns: LegacyColumn[] }> }

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

/** Reads a committed corpus directory into the shape FixtureLegacyDriver takes. Synchronous on purpose:
 *  it runs inside a test body, and an await here would buy nothing. */
export function loadCorpus(name = "base"): LegacyCorpus {
  const dir = join(CORPUS_ROOT, name);
  const catalog = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as CatalogFile;
  const tables: Record<string, { columns: readonly LegacyColumn[]; keyColumns: readonly string[]; rows: readonly LegacyRow[] }> = {};
  for (const [table, meta] of Object.entries(catalog.tables)) {
    tables[table] = {
      columns: meta.columns,
      keyColumns: meta.keyColumns,
      rows: JSON.parse(readFileSync(join(dir, `${table}.json`), "utf8")) as LegacyRow[],
    };
  }
  return { engineVersion: catalog.engineVersion, tables };
}
```

- [ ] **Step 10: Write `packages/importer/src/drivers/fixture.ts`**

```ts
import type { LegacyPredicate } from "../legacy/predicate";
import { unreadable, type LegacyColumn, type LegacyDriver, type LegacyRow, type SelectSpec } from "../legacy/types";

export interface LegacyCorpus {
  readonly engineVersion: string | null;
  readonly tables: Readonly<Record<string, { readonly columns: readonly LegacyColumn[]; readonly keyColumns: readonly string[]; readonly rows: readonly LegacyRow[] }>>;
}

/**
 * The local equivalent OD-17's task names (contracts §2.12 default: no access). It evaluates a `SelectSpec`
 * **structurally** over arrays — it parses no SQL and renders none, so it can never disagree with the ODBC
 * driver about a dialect it does not speak. Predicate evaluation arrives in Task 2; until then `where` is
 * rejected rather than ignored, because a silently ignored filter is how a reconciliation report lies.
 */
export class FixtureLegacyDriver implements LegacyDriver {
  readonly kind = "fixture" as const;
  readonly source: string;

  constructor(private readonly corpus: LegacyCorpus, source = "fixture corpus") {
    this.source = source;
  }

  engineVersion(): Promise<string | null> { return Promise.resolve(this.corpus.engineVersion); }
  tables(): Promise<string[]> { return Promise.resolve(Object.keys(this.corpus.tables).sort()); }
  columns(table: string): Promise<LegacyColumn[]> { return Promise.resolve([...this.table(table).columns]); }
  keyColumns(table: string): Promise<string[]> { return Promise.resolve([...this.table(table).keyColumns]); }
  close(): Promise<void> { return Promise.resolve(); }

  count(table: string, where?: LegacyPredicate): Promise<number> {
    return Promise.resolve(this.filtered(table, where).length);
  }

  minMax(table: string, column: string): Promise<{ min: string | null; max: string | null }> {
    this.assertColumn(table, column);
    const values = this.table(table).rows
      .map((r) => r[column])
      .filter((v): v is string => typeof v === "string" && v !== "")
      .sort();
    return Promise.resolve({ min: values[0] ?? null, max: values[values.length - 1] ?? null });
  }

  async *cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]> {
    if (batch < 1) throw unreadable(`batch size ${String(batch)} is not a positive integer`);
    const wanted = spec.columns.length > 0 ? spec.columns : this.table(spec.table).columns.map((c) => c.name);
    for (const name of wanted) this.assertColumn(spec.table, name);
    let rows = this.filtered(spec.table, spec.where);
    if (spec.orderBy && spec.orderBy.length > 0) {
      const keys = spec.orderBy;
      for (const name of keys) this.assertColumn(spec.table, name);
      rows = [...rows].sort((a, b) => {
        for (const k of keys) {
          const cmp = String(a[k] ?? "").localeCompare(String(b[k] ?? ""), "en");
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }
    for (let i = 0; i < rows.length; i += batch) {
      yield rows.slice(i, i + batch).map((row) => Object.fromEntries(wanted.map((c) => [c, row[c] ?? null])) as LegacyRow);
    }
  }

  private table(name: string): { columns: readonly LegacyColumn[]; keyColumns: readonly string[]; rows: readonly LegacyRow[] } {
    const found = this.corpus.tables[name];
    if (!found) throw unreadable(`table ${name} is not in the corpus`);
    return found;
  }

  private assertColumn(table: string, column: string): void {
    if (!this.table(table).columns.some((c) => c.name === column)) throw unreadable(`column ${table}.${column} is not in the corpus`);
  }

  private filtered(table: string, where?: LegacyPredicate): readonly LegacyRow[] {
    const rows = this.table(table).rows;
    if (!where) return rows;
    throw unreadable("predicate evaluation arrives in Task 2");
  }
}
```

- [ ] **Step 11: Run the test and see it pass**

Run: `bun run --cwd packages/importer test`
Expected: PASS — three `FixtureLegacyDriver` cases and one `LEGACY_MODULES` case.

- [ ] **Step 12: Run the whole gate**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: all green. `lint:rules` in particular must report **no** `no-bare-db` violation — if it names one, a binding in this package is called `db` or `sql` (assumption 10); rename it, do not add an allow-list entry.

- [ ] **Step 13: Commit**

```
feat(importer): add @dulja/importer with the legacy driver port and fixture driver [9A T1]

The seam every later task is developed against: LegacyDriver takes a structured
SelectSpec, never SQL text, and FixtureLegacyDriver evaluates it over a committed
synthetic corpus so no task in this slice needs the owner's database to go green
(contracts §2.12 OD-17 default). LEGACY_MODULES commits the dossier's 460-table
inventory as the instrument for Part VII #1.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 2: `LegacyPredicate` evaluation, the one SQL renderer, and ADR 0082

**Files:**
- Create: `packages/importer/src/drivers/sql.ts`, `docs/adr/0082-legacy-predicate-and-identifier-allow-list.md`
- Modify: `packages/importer/src/legacy/predicate.ts` (add `evaluatePredicate`), `packages/importer/src/drivers/fixture.ts` (`filtered` stops throwing)
- Test: `packages/importer/test/sql.test.ts`

**Interfaces:**
- Consumes: `LegacyPredicate` (T1), `LegacyColumn`, `SelectSpec`, `LegacyRow`, `unreadable` (T1).
- Produces:
  ```ts
  // packages/importer/src/legacy/predicate.ts
  export function evaluatePredicate(row: LegacyRow, predicate: LegacyPredicate): boolean;
  export function predicateColumns(predicate: LegacyPredicate): string[];
  // packages/importer/src/drivers/sql.ts
  export interface RenderedStatement { readonly text: string; readonly params: readonly LegacyScalar[] }
  export function quoteIdent(name: string, allowed: ReadonlySet<string>): string;
  export function renderSelect(spec: SelectSpec, columns: readonly LegacyColumn[]): RenderedStatement;
  export function renderCount(table: string, columns: readonly LegacyColumn[], where?: LegacyPredicate): RenderedStatement;
  export function renderMinMax(table: string, column: string, columns: readonly LegacyColumn[]): RenderedStatement;
  export const CAST_WIDTH: Readonly<Record<LegacyColumnKind, number | null>>;
  ```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/sql.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluatePredicate, predicateColumns } from "../src/legacy/predicate";
import { quoteIdent, renderCount, renderMinMax, renderSelect } from "../src/drivers/sql";
import type { LegacyColumn } from "../src/legacy/types";

const COLUMNS: LegacyColumn[] = [
  { name: "SITE", kind: "integer", scale: 0, nullable: false },
  { name: "ID", kind: "integer", scale: 0, nullable: false },
  { name: "DEBIT", kind: "decimal", scale: 4, nullable: true },
  { name: "EXCHANGE", kind: "float", scale: 0, nullable: true },
  { name: "DATE", kind: "date", scale: 0, nullable: true },
  { name: "NOTE", kind: "text", scale: 0, nullable: true },
];

describe("renderSelect — the only producer of statement text in this package (ADR 0082)", () => {
  it("casts every non-text column so no money or date ever arrives as a JavaScript number or Date", () => {
    const r = renderSelect({ table: "VOUITEMS", columns: ["ID", "DEBIT", "EXCHANGE", "DATE", "NOTE"] }, COLUMNS);
    expect(r.text).toBe(
      'select cast("ID" as varchar(20)) as "ID", cast("DEBIT" as varchar(40)) as "DEBIT",' +
      ' cast("EXCHANGE" as varchar(40)) as "EXCHANGE", cast("DATE" as varchar(24)) as "DATE", "NOTE" as "NOTE"' +
      ' from "VOUITEMS"',
    );
    expect(r.params).toEqual([]);
  });

  it("binds every value as a parameter and never as text", () => {
    const r = renderSelect(
      { table: "VOUITEMS", columns: ["ID"], orderBy: ["SITE", "ID"],
        where: { op: "and", operands: [
          { op: "eq", column: "SITE", value: "1" },
          { op: "or", operands: [{ op: "in", column: "ID", values: ["7", "9"] }, { op: "is_null", column: "NOTE" }] },
          { op: "between", column: "DATE", from: "2024-01-01", to: "2024-12-31" },
        ] } },
      COLUMNS,
    );
    expect(r.text).toBe(
      'select cast("ID" as varchar(20)) as "ID" from "VOUITEMS"' +
      ' where ("SITE" = ? and ("ID" in (?, ?) or "NOTE" is null) and "DATE" between ? and ?)' +
      ' order by "SITE", "ID"',
    );
    expect(r.params).toEqual(["1", "7", "9", "2024-01-01", "2024-12-31"]);
  });

  it("renders count and min/max on the native column, casting only the result", () => {
    expect(renderCount("VOUITEMS", COLUMNS).text).toBe('select cast(count(*) as varchar(20)) as "N" from "VOUITEMS"');
    expect(renderMinMax("VOUITEMS", "DATE", COLUMNS).text).toBe(
      'select cast(min("DATE") as varchar(24)) as "MIN_V", cast(max("DATE") as varchar(24)) as "MAX_V" from "VOUITEMS"',
    );
  });

  it("every shape it can produce starts with `select` — the reader is read-only by construction", () => {
    const shapes = [
      renderSelect({ table: "VOUITEMS", columns: [] }, COLUMNS),
      renderCount("VOUITEMS", COLUMNS, { op: "is_not_null", column: "NOTE" }),
      renderMinMax("VOUITEMS", "ID", COLUMNS),
    ];
    for (const s of shapes) expect(s.text.startsWith("select ")).toBe(true);
  });

  it("refuses an identifier at the shape gate and, separately, at the membership gate", () => {
    // `quoteIdent` runs before the declared-column lookup, and its two gates raise different messages.
    // `DROP TABLE` contains a space, so it never reaches the membership test: the shape test rejects it.
    expect(() => renderSelect({ table: "VOUITEMS", columns: ["DROP TABLE"] }, COLUMNS)).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: identifier DROP TABLE is not a bare Firebird identifier/,
    );
    // A well-formed name that is not a column of this table fails the membership test instead.
    expect(() => renderSelect({ table: "VOUITEMS", columns: ["NOSUCH"] }, COLUMNS)).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: identifier NOSUCH is not a declared column or table of this source/,
    );
    // The table's own name passes both gates and is still not a column, which is `projection`'s own message.
    expect(() => renderSelect({ table: "VOUITEMS", columns: ["VOUITEMS"] }, COLUMNS)).toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: identifier VOUITEMS is not a declared column of VOUITEMS/,
    );
    expect(() => quoteIdent('X" or 1=1 --', new Set(["X"]))).toThrow(/ERR_IMPORT_SOURCE_UNREADABLE/);
    expect(quoteIdent("VOUITEMS", new Set(["VOUITEMS"]))).toBe('"VOUITEMS"');
  });
});

describe("evaluatePredicate — the fixture driver's structural evaluation of the same predicate", () => {
  const row = { SITE: "1", ID: "7", NOTE: null, DATE: "2024-06-01" };

  it("agrees with the SQL semantics of every operator", () => {
    expect(evaluatePredicate(row, { op: "eq", column: "SITE", value: "1" })).toBe(true);
    expect(evaluatePredicate(row, { op: "ne", column: "SITE", value: "1" })).toBe(false);
    expect(evaluatePredicate(row, { op: "in", column: "ID", values: ["7", "9"] })).toBe(true);
    expect(evaluatePredicate(row, { op: "is_null", column: "NOTE" })).toBe(true);
    expect(evaluatePredicate(row, { op: "is_not_null", column: "NOTE" })).toBe(false);
    expect(evaluatePredicate(row, { op: "between", column: "DATE", from: "2024-01-01", to: "2024-12-31" })).toBe(true);
    expect(evaluatePredicate(row, { op: "gt", column: "DATE", value: "2024-12-31" })).toBe(false);
    expect(evaluatePredicate(row, { op: "and", operands: [{ op: "eq", column: "SITE", value: "1" }, { op: "is_null", column: "NOTE" }] })).toBe(true);
    expect(evaluatePredicate(row, { op: "or", operands: [{ op: "eq", column: "SITE", value: "2" }, { op: "is_null", column: "NOTE" }] })).toBe(true);
  });

  it("treats a comparison against NULL as unknown, exactly as SQL does", () => {
    expect(evaluatePredicate(row, { op: "eq", column: "NOTE", value: "x" })).toBe(false);
    expect(evaluatePredicate(row, { op: "ne", column: "NOTE", value: "x" })).toBe(false);
  });

  it("names every column a predicate touches, so the driver can validate them", () => {
    expect(predicateColumns({ op: "and", operands: [{ op: "eq", column: "SITE", value: "1" }, { op: "is_null", column: "NOTE" }] }))
      .toEqual(["SITE", "NOTE"]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test sql`
Expected: FAIL — `Cannot find module '../src/drivers/sql'`.

- [ ] **Step 3: Add `evaluatePredicate` and `predicateColumns` to `packages/importer/src/legacy/predicate.ts`**

Append below the existing type:

```ts
import type { LegacyRow, LegacyScalar } from "./types";

/**
 * SQL three-valued logic, reproduced exactly: any comparison whose operand is NULL is unknown, and unknown is
 * not true. Getting this wrong in the fixture driver would make a reconciliation test pass on rows the live
 * database excludes — which is the whole class of defect this slice exists to find (LEGACY-011).
 */
export function evaluatePredicate(row: LegacyRow, predicate: LegacyPredicate): boolean {
  switch (predicate.op) {
    case "and": return predicate.operands.every((p) => evaluatePredicate(row, p));
    case "or": return predicate.operands.some((p) => evaluatePredicate(row, p));
    case "is_null": return row[predicate.column] === null || row[predicate.column] === undefined;
    case "is_not_null": return row[predicate.column] !== null && row[predicate.column] !== undefined;
    case "between": {
      const v = row[predicate.column];
      return typeof v === "string" && v >= predicate.from && v <= predicate.to;
    }
    case "in": {
      const v = row[predicate.column];
      return v !== null && v !== undefined && predicate.values.includes(v);
    }
    default: {
      const v = row[predicate.column] ?? null;
      if (v === null || predicate.value === null) return false;
      return compare(v, predicate.value, predicate.op);
    }
  }
}

function compare(left: LegacyScalar, right: LegacyScalar, op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"): boolean {
  const a = String(left);
  const b = String(right);
  switch (op) {
    case "eq": return a === b;
    case "ne": return a !== b;
    case "lt": return a < b;
    case "lte": return a <= b;
    case "gt": return a > b;
    case "gte": return a >= b;
  }
}

/** Every column a predicate names, in first-appearance order — the driver validates these before rendering. */
export function predicateColumns(predicate: LegacyPredicate): string[] {
  if (predicate.op === "and" || predicate.op === "or") {
    const seen: string[] = [];
    for (const operand of predicate.operands) {
      for (const column of predicateColumns(operand)) if (!seen.includes(column)) seen.push(column);
    }
    return seen;
  }
  return [predicate.column];
}
```

- [ ] **Step 4: Write `packages/importer/src/drivers/sql.ts`**

```ts
import type { LegacyPredicate } from "../legacy/predicate";
import { predicateColumns } from "../legacy/predicate";
import { unreadable, type LegacyColumn, type LegacyColumnKind, type LegacyScalar, type SelectSpec } from "../legacy/types";

export interface RenderedStatement { readonly text: string; readonly params: readonly LegacyScalar[] }

/**
 * How wide the `varchar` a column is cast to must be. `null` means "already text; do not cast".
 *
 * Everything numeric and everything temporal is cast so the value reaches TypeScript as exact decimal text:
 * spec:99 forbids a float holding money "anywhere, including in TypeScript", and an ODBC driver returns
 * NUMERIC(18,4) as a JavaScript number and DATE as a Date in the process's local zone unless the query says
 * otherwise. 40 characters covers Firebird's widest NUMERIC(18,4) with sign and point; 24 covers
 * `YYYY-MM-DD HH:MM:SS.mmmm`; 20 covers a 64-bit integer with sign.
 */
export const CAST_WIDTH: Readonly<Record<LegacyColumnKind, number | null>> = {
  text: null, decimal: 40, float: 40, integer: 20, date: 24, timestamp: 24, time: 24, blob: null, other: 40,
};

const IDENT = /^[A-Z_$][A-Z0-9_$]{0,62}$/;

/**
 * Quote an identifier for Firebird dialect 3, having first proved it is one of a known set. Two gates, not one:
 * the shape test rejects anything that is not a bare identifier, and the membership test rejects a
 * well-formed name that is not a real column or table here. Neither is decoration — the second is what makes
 * a caller-supplied `LegacyPredicate.column` safe (ADR 0082).
 */
export function quoteIdent(name: string, allowed: ReadonlySet<string>): string {
  const upper = name.trim().toUpperCase();
  if (!IDENT.test(upper)) throw unreadable(`identifier ${name} is not a bare Firebird identifier`);
  if (!allowed.has(upper)) throw unreadable(`identifier ${name} is not a declared column or table of this source`);
  return ['"', upper, '"'].join("");
}

/**
 * Statement text is assembled by pushing tokens into an array and joining them, never by interpolating an
 * identifier into a template literal beside a SQL keyword: `no-sql-concat` (0B, contracts §3.7.5) flags any
 * untagged template whose body carries both an interpolation and a keyword, and that rule has no allow-list.
 * The shape is deliberate as well as mechanical — a keyword and an identifier never meet in one expression,
 * so there is no place for a caller's string to become syntax.
 */
function projection(spec: SelectSpec, columns: readonly LegacyColumn[], names: ReadonlySet<string>): string {
  const wanted = spec.columns.length > 0 ? spec.columns : columns.map((c) => c.name);
  return wanted
    .map((requested) => {
      const quoted = quoteIdent(requested, names);
      const column = columns.find((c) => c.name === requested.trim().toUpperCase());
      if (!column) throw unreadable(`identifier ${requested} is not a declared column of ${spec.table}`);
      const width = CAST_WIDTH[column.kind];
      const value = width === null ? quoted : ["cast(", quoted, " as varchar(", String(width), "))"].join("");
      return [value, "as", quoted].join(" ");
    })
    .join(", ");
}

function condition(predicate: LegacyPredicate, names: ReadonlySet<string>, params: LegacyScalar[]): string {
  if (predicate.op === "and" || predicate.op === "or") {
    if (predicate.operands.length === 0) throw unreadable(`an empty ${predicate.op} predicate has no meaning`);
    const joiner = [" ", predicate.op, " "].join("");
    return ["(", predicate.operands.map((p) => condition(p, names, params)).join(joiner), ")"].join("");
  }
  const column = quoteIdent(predicate.column, names);
  switch (predicate.op) {
    case "is_null": return [column, "is null"].join(" ");
    case "is_not_null": return [column, "is not null"].join(" ");
    case "between":
      params.push(predicate.from, predicate.to);
      return [column, "between ? and ?"].join(" ");
    case "in": {
      if (predicate.values.length === 0) throw unreadable(`an empty in-list on ${predicate.column} has no meaning`);
      for (const value of predicate.values) params.push(value);
      return [column, " in (", predicate.values.map(() => "?").join(", "), ")"].join("");
    }
    default: {
      params.push(predicate.value);
      return [column, OPERATOR[predicate.op], "?"].join(" ");
    }
  }
}

const OPERATOR: Readonly<Record<"eq" | "ne" | "lt" | "lte" | "gt" | "gte", string>> = {
  eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=",
};

function namesOf(columns: readonly LegacyColumn[], table: string): ReadonlySet<string> {
  return new Set([...columns.map((c) => c.name), table.trim().toUpperCase()]);
}

export function renderSelect(spec: SelectSpec, columns: readonly LegacyColumn[]): RenderedStatement {
  const names = namesOf(columns, spec.table);
  const params: LegacyScalar[] = [];
  const parts = ["select", projection(spec, columns, names), "from", quoteIdent(spec.table, names)];
  if (spec.where) {
    for (const column of predicateColumns(spec.where)) quoteIdent(column, names);
    parts.push("where", condition(spec.where, names, params));
  }
  if (spec.orderBy && spec.orderBy.length > 0) {
    parts.push("order by", spec.orderBy.map((c) => quoteIdent(c, names)).join(", "));
  }
  return { text: parts.join(" "), params };
}

export function renderCount(table: string, columns: readonly LegacyColumn[], where?: LegacyPredicate): RenderedStatement {
  const names = namesOf(columns, table);
  const params: LegacyScalar[] = [];
  const parts = ["select", 'cast(count(*) as varchar(20)) as "N"', "from", quoteIdent(table, names)];
  if (where) parts.push("where", condition(where, names, params));
  return { text: parts.join(" "), params };
}

export function renderMinMax(table: string, column: string, columns: readonly LegacyColumn[]): RenderedStatement {
  const names = namesOf(columns, table);
  const quoted = quoteIdent(column, names);
  // min/max run on the NATIVE column and only the result is cast, so the ordering is the source's own and not
  // the lexicographic ordering of its text form. `dateRange` (§4.13.1) returns strings either way.
  const aggregate = [
    ["cast(min(", quoted, ') as varchar(24)) as "MIN_V"'].join(""),
    ["cast(max(", quoted, ') as varchar(24)) as "MAX_V"'].join(""),
  ].join(", ");
  return { text: ["select", aggregate, "from", quoteIdent(table, names)].join(" "), params: [] };
}
```

The `in` branch is the one place a token carries its own leading space: `join("")` puts nothing between the
quoted column and `in (`, so the space lives inside the literal `" in ("`. Step 1's expectation
(`"ID" in (?, ?)`) is what holds it.

- [ ] **Step 5: Let the fixture driver evaluate predicates**

In `packages/importer/src/drivers/fixture.ts`, replace the body of `filtered`:

```ts
  private filtered(table: string, where?: LegacyPredicate): readonly LegacyRow[] {
    const rows = this.table(table).rows;
    if (!where) return rows;
    for (const column of predicateColumns(where)) this.assertColumn(table, column);
    return rows.filter((row) => evaluatePredicate(row, where));
  }
```

and add the import: `import { evaluatePredicate, predicateColumns, type LegacyPredicate } from "../legacy/predicate";` (replacing the type-only import).

- [ ] **Step 6: Run the tests and see them pass**

Run: `bun run --cwd packages/importer test`
Expected: PASS — the four `fixture-driver` cases and the eight `sql` cases.

- [ ] **Step 7: Write ADR 0082**

`docs/adr/0082-legacy-predicate-and-identifier-allow-list.md`, in Plan 0A's ADR format:

```markdown
# ADR 0082 — The legacy reader composes SQL from catalogue-validated identifiers and bound values

**Status:** Accepted · **Date:** 2026-09-05 · **Slice:** 9A · **Supersedes:** none

## Context

spec:100 forbids building SQL by string concatenation (LEGACY-036/037/069), and contracts §4.13.1 requires that
`LegacyReader.read`'s `where` be "a typed structure, never SQL text". But the legacy source is Firebird, where a
table or column name cannot be a bound parameter: some identifier must reach the statement as text, and the
tables the profiler walks are named at run time from the catalogue, not at compile time.

0B's `no-sql-concat` rule has a second half with no allow-list at all: any untagged template literal whose body
contains both an interpolation and a SQL keyword is a violation anywhere under `apps/` or `packages/`. So the
renderer cannot be written in the obvious style even if we wanted to.

## Decision

1. **`LegacyPredicate` is a closed, typed structure** (`packages/importer/src/legacy/predicate.ts`). It has no
   member that can carry SQL, and 9B consumes it without extending it.
2. **Every value is a bound `?` parameter.** No literal a caller supplies ever reaches statement text.
3. **Every identifier passes two gates before it is quoted:** a shape test (`^[A-Z_$][A-Z0-9_$]{0,62}$`) and a
   membership test against the columns the catalogue declares for that table (or, when no live catalogue is
   reachable, `LEGACY_MODULES`). `quoteIdent` raises `ERR_IMPORT_SOURCE_UNREADABLE` on either failure.
4. **Statement text is assembled by joining an array of tokens**, so a keyword and an identifier are never in
   the same expression. `packages/importer/src/drivers/sql.ts` is the only file in the package that produces
   statement text, and its three functions are the only shapes that exist.
5. **Every shape starts with `select`**, and a test asserts it. The reader cannot write.
6. **Every non-text column is cast to `varchar` in the projection** so no monetary value arrives as a
   JavaScript number and no date arrives as a `Date` in the process's local zone (spec:2039, spec:2041).

## Consequences

- `packages/importer/src/reader.ts` appears on `no-sql-concat`'s `UNSAFE_ALLOW` list (0B shipped it as one of
  the three homes of `sql.unsafe`, contracts §3.3) and **does not use it**: the ODBC driver calls the `odbc`
  package's own parameterised `query(text, params)`. The allow-list entry stays as a permission.
- Ordering is lexicographic over the text form in both drivers, deliberately: it is a total order, it is the
  same order on both sides, and nothing in Phase 9 depends on numeric ordering.
- A future need for a SQL construct these three shapes cannot express amends this ADR and adds a fourth
  renderer function; it never adds a `text` member to `LegacyPredicate`.
```

- [ ] **Step 8: Run the whole gate**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: all green, and `lint:rules` reports no `no-sql-concat` violation in `packages/importer/src/drivers/sql.ts`. If it does, an identifier and a keyword have met inside one template literal — split them into two array elements.

- [ ] **Step 9: Commit**

```
feat(importer): render legacy SQL from validated identifiers and bound values [9A T2]

LegacyPredicate is a closed typed structure (contracts §4.13.1); every value is a
bound parameter; every identifier passes a shape and a membership gate before it is
quoted; every shape starts with `select`. The fixture driver evaluates the same
predicate structurally with SQL three-valued logic, so a filter means the same thing
on both sides. ADR 0082.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 3: OWNER GATE OD-17 — the live Firebird driver, the version probe, the scoping report, ADR 0081

> **This task is isolated (contracts §2.0, §2.12).** It is the only task in this plan that reads a byte of the
> owner's data. Drop it, defer it, or swap the driver, and Tasks 1–2 and 4–14 stay green — they run against
> `FixtureLegacyDriver`. It is written now; only its *execution* waits on the owner.
>
> **Owner provides (OD-17, spec:2409, 2469):** a read-only ODBC DSN for the live legacy database (and, if
> OD-16 turns out to be *yes*, a second one for `mposSystem`/`mposStandard`), plus — if the engine-version
> probe comes back empty — the Firebird version as a string.
>
> **Verify:** `bun run legacy scope --dsn "$LEGACY_ODBC_DSN" --out artefacts/legacy/scope` prints
> `engine: <version>` · `tables: <n> read, <m> in the shipped map, <k> unexpected` · `rows: <total>` ·
> `wrote: artefacts/legacy/scope/scope.json` and exits **0**.
>
> **Until provided:** the identical command with `--fixture base` instead of `--dsn` prints the same five lines
> against the committed corpus and exits 0. Every later task's tests use `--fixture`.

**Files:**
- Create: `packages/importer/src/drivers/odbc.ts`, `packages/importer/src/scope.ts`, `packages/importer/src/cli.ts`, `docs/adr/0081-firebird-version-and-extraction-method.md`
- Test: `packages/importer/test/scope.test.ts`, `packages/importer/test/odbc.test.ts`

**Interfaces:**
- Consumes: `LegacyDriver`, `LegacyColumn`, `unreadable` (T1); `renderSelect`, `renderCount`, `renderMinMax`, `quoteIdent` (T2); `LEGACY_MODULES`, `ALL_LEGACY_TABLES`, `moduleOf` (T1).
- Produces:
  ```ts
  // packages/importer/src/drivers/odbc.ts
  export interface OdbcOptions { readonly dsn: string; readonly firebirdVersion?: string }
  export async function connectOdbc(opts: OdbcOptions): Promise<OdbcLegacyDriver>;
  export class OdbcLegacyDriver implements LegacyDriver { close(): Promise<void> }
  export function redactDsn(dsn: string): string;
  // packages/importer/src/scope.ts
  export interface TableScope { readonly table: string; readonly module: string | null; readonly rows: number; readonly dateColumn: string | null; readonly dateRange: { min: string | null; max: string | null } | null; readonly note: string | null }
  export interface ScopeReport { readonly generatedAt: string; readonly source: string; readonly engineVersion: string | null; readonly tables: readonly TableScope[]; readonly unexpectedTables: readonly string[]; readonly missingTables: readonly string[]; readonly totalRows: number }
  export async function scope(driver: LegacyDriver): Promise<ScopeReport>;
  export const DATE_COLUMN_CANDIDATES: readonly string[];
  ```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { scope } from "../src/scope";
import { loadCorpus } from "./support/corpus";

describe("scope — Part VII #1 and #2, §5.1 #10 'scope first, migrate second'", () => {
  it("counts every table, finds each one's date range, and names its module", async () => {
    const report = await scope(new FixtureLegacyDriver(loadCorpus()));
    expect(report.engineVersion).toBe("WI-V2.5.9.27139 Firebird 2.5");
    expect(report.source).toBe("fixture corpus");
    expect(report.totalRows).toBe(9);
    expect(report.tables).toEqual([
      { table: "ACCOUNTS", module: "standard", rows: 3, dateColumn: null, dateRange: null, note: null },
      { table: "VOUCHERS", module: "standard", rows: 2, dateColumn: "DATE", dateRange: { min: "2024-01-15", max: "2024-03-02" }, note: null },
      { table: "VOUITEMS", module: "standard", rows: 4, dateColumn: null, dateRange: null, note: null },
    ]);
  });

  it("reports both directions of the difference against the shipped 460-table map", async () => {
    const report = await scope(new FixtureLegacyDriver(loadCorpus()));
    expect(report.unexpectedTables).toEqual([]);
    // 460 shipped minus the three the corpus holds.
    expect(report.missingTables).toHaveLength(457);
    expect(report.missingTables).toContain("PAYROLLS");
  });

  it("records a table it cannot read rather than failing the whole run", async () => {
    const corpus = loadCorpus();
    const broken = new FixtureLegacyDriver({
      ...corpus,
      tables: { ...corpus.tables, BILLITEMS: { columns: [], keyColumns: [], rows: [] } },
    });
    const report = await scope(broken);
    const row = report.tables.find((t) => t.table === "BILLITEMS");
    expect(row?.rows).toBe(0);
    expect(row?.note).toBe("no columns declared");
  });

  it("is timestamped in UTC to the second, so two runs are comparable", async () => {
    const report = await scope(new FixtureLegacyDriver(loadCorpus()));
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
```

`packages/importer/test/odbc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { redactDsn } from "../src/drivers/odbc";

const DSN = process.env.LEGACY_ODBC_DSN;

describe("redactDsn — no credential reaches an artefact or a log line", () => {
  it("keeps the driver and the database and drops everything secret", () => {
    expect(redactDsn("DRIVER={Firebird/InterBase(r) driver};UID=SYSDBA;PWD=masterkey;DBNAME=C:/db/STANDARD.FDB"))
      .toBe("DRIVER={Firebird/InterBase(r) driver};UID=***;PWD=***;DBNAME=C:/db/STANDARD.FDB");
  });
});

// contracts §3.7.1 gives `tests/staging` the same shape: a suite that needs a real endpoint is skipped, never
// failed, when the endpoint is not configured. This one needs the owner's database (OD-17).
describe.skipIf(!DSN)("OdbcLegacyDriver against the live source (OD-17)", () => {
  it("reports an engine version or refuses to guess one", async () => {
    const { connectOdbc } = await import("../src/drivers/odbc");
    const driver = await connectOdbc({ dsn: DSN as string });
    try {
      const version = await driver.engineVersion();
      expect(version === null || version.length > 0).toBe(true);
      expect((await driver.tables()).length).toBeGreaterThan(0);
    } finally {
      await driver.close();
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test scope`
Expected: FAIL — `Cannot find module '../src/scope'`.

- [ ] **Step 3: Write `packages/importer/src/drivers/odbc.ts`**

```ts
import { renderCount, renderMinMax, renderSelect } from "./sql";
import type { LegacyPredicate } from "../legacy/predicate";
import { unreadable, type LegacyColumn, type LegacyColumnKind, type LegacyDriver, type LegacyRow, type SelectSpec } from "../legacy/types";

export interface OdbcOptions {
  readonly dsn: string;
  /** Supplied by the owner when the engine cannot be asked (Firebird before 2.1). ADR 0081 records it. */
  readonly firebirdVersion?: string;
}

interface OdbcConnection {
  query(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** Strips every credential from a DSN so it can appear in an artefact header and a log line (spec:2063). */
export function redactDsn(dsn: string): string {
  return dsn.replace(/\b(UID|USER|PWD|PASSWORD)=([^;]*)/gi, (_m, key: string) => [key, "***"].join("="));
}

/**
 * Firebird's RDB$FIELD_TYPE codes, mapped to the classification the renderer casts on. The numbers are the
 * engine's own and are stable across every version in the field; the scale test is what separates an integer
 * from a scaled decimal, because Firebird stores NUMERIC(18,4) as a BIGINT with RDB$FIELD_SCALE = -4.
 */
function classify(fieldType: number, scale: number, subType: number): { kind: LegacyColumnKind; scale: number } {
  if (scale < 0) return { kind: "decimal", scale: -scale };
  switch (fieldType) {
    case 7: case 8: case 16: return { kind: subType === 1 || subType === 2 ? "decimal" : "integer", scale: 0 };
    case 10: case 27: return { kind: "float", scale: 0 };
    case 12: return { kind: "date", scale: 0 };
    case 13: return { kind: "time", scale: 0 };
    case 35: return { kind: "timestamp", scale: 0 };
    case 14: case 37: return { kind: "text", scale: 0 };
    case 261: return { kind: "blob", scale: 0 };
    default: return { kind: "other", scale: 0 };
  }
}

/**
 * The live driver. Which extraction method ADR 0081 records — reading the production database directly,
 * restoring a `gbak` backup into a throwaway instance first, or attaching a copied `.fdb` — changes the
 * runbook and not this class: all three terminate at one SQL connection (Part VII #5).
 */
export class OdbcLegacyDriver implements LegacyDriver {
  readonly kind = "odbc" as const;
  readonly source: string;
  private readonly catalogue = new Map<string, LegacyColumn[]>();
  private readonly keys = new Map<string, string[]>();

  constructor(private readonly conn: OdbcConnection, dsn: string, private readonly declaredVersion?: string) {
    this.source = redactDsn(dsn);
  }

  /** Firebird 2.1 and later answer this; earlier engines raise, and the owner's `--firebird-version` stands in. */
  async engineVersion(): Promise<string | null> {
    if (this.declaredVersion) return this.declaredVersion;
    try {
      const rows = await this.conn.query(
        `select cast(rdb$get_context('SYSTEM', 'ENGINE_VERSION') as varchar(40)) as "V" from rdb$database`,
      );
      const value = rows[0]?.V;
      return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
    } catch {
      return null;
    }
  }

  async tables(): Promise<string[]> {
    const rows = await this.conn.query(
      `select trim(rdb$relation_name) as "T" from rdb$relations where coalesce(rdb$system_flag, 0) = 0 and rdb$view_blr is null order by 1`,
    );
    return rows.map((r) => String(r.T));
  }

  async columns(table: string): Promise<LegacyColumn[]> {
    const cached = this.catalogue.get(table);
    if (cached) return cached;
    const rows = await this.conn.query(
      `select trim(rf.rdb$field_name) as "N", f.rdb$field_type as "T", coalesce(f.rdb$field_scale, 0) as "S", coalesce(f.rdb$field_sub_type, 0) as "U", coalesce(rf.rdb$null_flag, 0) as "NN" from rdb$relation_fields rf join rdb$fields f on f.rdb$field_name = rf.rdb$field_source where rf.rdb$relation_name = ? order by rf.rdb$field_position`,
      [table],
    );
    if (rows.length === 0) throw unreadable(`table ${table} declares no columns`);
    const columns = rows.map((r) => {
      const { kind, scale } = classify(Number(r.T), Number(r.S), Number(r.U));
      return { name: String(r.N), kind, scale, nullable: Number(r.NN) === 0 };
    });
    this.catalogue.set(table, columns);
    return columns;
  }

  /** The primary key's columns in position order; an empty array for the 42 tables that have none (LEGACY-074). */
  async keyColumns(table: string): Promise<string[]> {
    const cached = this.keys.get(table);
    if (cached) return cached;
    const rows = await this.conn.query(
      `select trim(s.rdb$field_name) as "N" from rdb$relation_constraints c join rdb$index_segments s on s.rdb$index_name = c.rdb$index_name where c.rdb$relation_name = ? and c.rdb$constraint_type = 'PRIMARY KEY' order by s.rdb$field_position`,
      [table],
    );
    const names = rows.map((r) => String(r.N));
    this.keys.set(table, names);
    return names;
  }

  async count(table: string, where?: LegacyPredicate): Promise<number> {
    const statement = renderCount(table, await this.columns(table), where);
    const rows = await this.conn.query(statement.text, statement.params);
    const n = Number.parseInt(String(rows[0]?.N ?? ""), 10);
    if (!Number.isSafeInteger(n)) throw unreadable(`count(*) on ${table} did not return an integer`);
    return n;
  }

  async minMax(table: string, column: string): Promise<{ min: string | null; max: string | null }> {
    const statement = renderMinMax(table, column, await this.columns(table));
    const rows = await this.conn.query(statement.text, statement.params);
    return { min: text(rows[0]?.MIN_V), max: text(rows[0]?.MAX_V) };
  }

  async *cursor(spec: SelectSpec, batch: number): AsyncIterable<LegacyRow[]> {
    if (batch < 1) throw unreadable(`batch size ${String(batch)} is not a positive integer`);
    const columns = await this.columns(spec.table);
    const keyColumns = spec.orderBy ?? (await this.keyColumns(spec.table));
    const statement = renderSelect({ ...spec, orderBy: keyColumns }, columns);
    const rows = await this.conn.query(statement.text, statement.params);
    for (let i = 0; i < rows.length; i += batch) {
      yield rows.slice(i, i + batch).map((row) => coerce(row, spec.table));
    }
  }

  close(): Promise<void> { return this.conn.close(); }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value).trim();
}

/**
 * Every value the renderer cast to varchar must arrive as a string. If a `number` reaches here the cast was
 * lost, and a monetary figure is one float-rounding away from being wrong — refuse rather than continue
 * (spec:99; LEGACY-012, where base amounts were never derived from value × rate and nobody noticed).
 */
function coerce(row: Record<string, unknown>, table: string): LegacyRow {
  const out: Record<string, string | boolean | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number") throw unreadable(`${table}.${key} arrived as a JavaScript number; the varchar cast was lost`);
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === "boolean") out[key] = value;
    else if (value instanceof Date) throw unreadable(`${table}.${key} arrived as a Date; the varchar cast was lost`);
    else out[key] = String(value).trim();
  }
  return out;
}

/**
 * The `odbc` package is a native module. It is imported here and nowhere else, and lazily, so every test in
 * this package runs on a machine with no ODBC driver manager installed (assumption 4).
 */
export async function connectOdbc(opts: OdbcOptions): Promise<OdbcLegacyDriver> {
  const odbc = await import("odbc");
  try {
    const conn = (await odbc.connect(opts.dsn)) as unknown as OdbcConnection;
    return new OdbcLegacyDriver(conn, opts.dsn, opts.firebirdVersion);
  } catch (cause) {
    throw unreadable(`cannot open ${redactDsn(opts.dsn)}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
```

**Every catalogue statement above is one unbroken template literal, and none may be split.** The three
`RDB$` reads are long enough to tempt a `+` join across two lines, and spec:100 — copied verbatim into this
plan's Global Constraints — forbids building SQL by string concatenation with no exception for a `+` whose
operands are both literals. The house rule is about the *shape* of the code, not about whether a given
concatenation happens to be exploitable: a reviewer reading `` `select … from x` + ` where …` `` cannot tell at
a glance that no caller value is in the chain, which is exactly the review failure LEGACY-036/037/069 record.
(0B's `no-sql-concat` would not fire here — its `CONCAT` regex is `/["'][^"']*\b(select|from|where)\b[^"']*["']\s*\+/i`
and matches only single- or double-quoted strings, and its template branch requires an interpolation, 0B:5014.
The rule is narrower than the rule it enforces; the constraint is the spec line, not the linter.) Task 13's
`constraints(table)` statement follows the same shape for the same reason.

`cursor` reads the whole result set and then yields it in slices rather than streaming: the largest table this
slice reads is bounded by the scoping run's own row counts, and a batching *interface* that a later task can
back with a real cursor is worth more here than a streaming implementation nobody has measured. **9B, which
reads every row of `BillItems`, replaces the body of this one method with the `odbc` cursor API** and changes
nothing above it — that is why the seam is an `AsyncIterable` and not an array.

- [ ] **Step 4: Write `packages/importer/src/scope.ts`**

```ts
import { ALL_LEGACY_TABLES, moduleOf } from "./legacy/modules";
import type { LegacyDriver } from "./legacy/types";

export interface TableScope {
  readonly table: string;
  readonly module: string | null;
  readonly rows: number;
  readonly dateColumn: string | null;
  readonly dateRange: { min: string | null; max: string | null } | null;
  readonly note: string | null;
}

export interface ScopeReport {
  readonly generatedAt: string;
  readonly source: string;
  readonly engineVersion: string | null;
  readonly tables: readonly TableScope[];
  /** In the database, not in the shipped 460-table map — a customisation, or a version drift. */
  readonly unexpectedTables: readonly string[];
  /** In the map, not in the database. */
  readonly missingTables: readonly string[];
  readonly totalRows: number;
}

/**
 * The column a table's date range is taken from, in preference order. The legacy system names its business date `DATE`
 * on documents and vouchers and `ENTRYDATE`/`PAYDATE` on a handful of others; a table with none of these gets a
 * null range rather than a guess. Part VII #2 wants the range on `Journal`, `BillItems` and `VouItems`, which
 * inherit theirs from their headers — so a null here is an answer, not a gap.
 */
export const DATE_COLUMN_CANDIDATES: readonly string[] = ["DATE", "ENTRYDATE", "PAYDATE", "DUEDATE", "CREATED"];

/** ISO-8601 to the second, in UTC, so two runs of the same command are diffable (spec:2039). */
function stamp(): string {
  return [new Date().toISOString().slice(0, 19), "Z"].join("");
}

/**
 * §5.1 #10 — "Scope first, migrate second. Run row counts per table against the live database before designing
 * the importer. 460 tables is the shipped surface, not the used surface." One table that cannot be read is
 * recorded and the run continues: a scoping report that aborts on the first bad table tells the owner nothing.
 */
export async function scope(driver: LegacyDriver): Promise<ScopeReport> {
  const present = await driver.tables();
  const tables: TableScope[] = [];
  let totalRows = 0;

  for (const table of present) {
    const module = moduleOf(table)?.id ?? null;
    try {
      const columns = await driver.columns(table);
      // The two drivers disagree about a table with nothing declared: `OdbcLegacyDriver.columns` raises
      // ("declares no columns"), while `FixtureLegacyDriver.columns` returns `[]` — a corpus entry can hold an
      // empty column list without being absent. Both mean the same thing to a scoping report, and neither is
      // a reason to abandon the run, so the empty list is turned into the same note here rather than left to
      // the catch below (which only ever sees the ODBC form).
      if (columns.length === 0) {
        tables.push({ table, module, rows: 0, dateColumn: null, dateRange: null, note: "no columns declared" });
        continue;
      }
      const rows = await driver.count(table);
      totalRows += rows;
      const dateColumn = DATE_COLUMN_CANDIDATES.find((c) => columns.some((col) => col.name === c)) ?? null;
      const dateRange = dateColumn && rows > 0 ? await driver.minMax(table, dateColumn) : null;
      tables.push({ table, module, rows, dateColumn, dateRange, note: null });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const note = message.includes("declares no columns") || message.includes("is not in the corpus")
        ? "no columns declared"
        : message.replace("ERR_IMPORT_SOURCE_UNREADABLE: ", "");
      tables.push({ table, module, rows: 0, dateColumn: null, dateRange: null, note });
    }
  }

  const seen = new Set(present);
  return {
    generatedAt: stamp(),
    source: driver.source,
    engineVersion: await driver.engineVersion(),
    tables,
    unexpectedTables: present.filter((t) => !ALL_LEGACY_TABLES.has(t)).sort(),
    missingTables: [...ALL_LEGACY_TABLES].filter((t) => !seen.has(t)).sort(),
    totalRows,
  };
}
```

- [ ] **Step 5: Write `packages/importer/src/cli.ts` — the argument parser and the `scope` command**

```ts
/* eslint-disable no-console -- contracts §3.2: `packages/*/src/cli.ts` is the one place a CLI may print. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureLegacyDriver } from "./drivers/fixture";
import { connectOdbc } from "./drivers/odbc";
import { scope } from "./scope";
import { unreadable, type LegacyColumn, type LegacyDriver, type LegacyRow } from "./legacy/types";

export interface CliArgs { readonly command: string; readonly flags: Readonly<Record<string, string>>; readonly switches: ReadonlySet<string> }

/** `--key value` becomes a flag; `--key` with no value becomes a switch. No third form exists. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) switches.add(key);
    else { flags[key] = next; i += 1; }
  }
  return { command, flags, switches };
}

const EXIT_CONFIG = 2;      // matches packages/db/src/cli.ts (plan0A:774–798)
const EXIT_UNREADABLE = 3;

async function openDriver(args: CliArgs): Promise<LegacyDriver> {
  const fixture = args.flags.fixture;
  if (fixture) {
    const { readFileSync, readdirSync } = await import("node:fs");
    // Resolved from this module's own URL, never from `process.cwd()`. The root script is
    // `"legacy": "bun run --cwd packages/importer src/cli.ts"`, so the cwd of every `bun run legacy …`
    // invocation is already `packages/importer`, so `join("packages/importer/test/corpus", fixture)` would
    // resolve to `packages/importer/packages/importer/test/corpus/<name>` and raise ENOENT from readFileSync.
    // `import.meta.url` makes the command work from the repository root, from the package, and from a test.
    const dir = join(fileURLToPath(new URL("../test/corpus", import.meta.url)), fixture);
    interface CatalogFile { engineVersion: string | null; tables: Record<string, { keyColumns: string[]; columns: LegacyColumn[] }> }
    const catalog = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8")) as CatalogFile;
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && f !== "catalog.json")
      .map((f) => {
        const name = f.replace(/\.json$/, "");
        const meta = catalog.tables[name];
        if (!meta) throw unreadable([name, "has rows but no catalog entry"].join(" "));
        const rows = JSON.parse(readFileSync(join(dir, f), "utf8")) as LegacyRow[];
        return [name, { columns: meta.columns, keyColumns: meta.keyColumns, rows }] as const;
      });
    return new FixtureLegacyDriver({ engineVersion: catalog.engineVersion, tables: Object.fromEntries(entries) });
  }
  const dsn = args.flags.dsn ?? process.env.LEGACY_ODBC_DSN;
  // Throws rather than calling `process.exit`, so `main()` stays safely importable from a test (Task 14's
  // `cli.test.ts`). The message carries no ERR_ token, so `main`'s catch maps it to EXIT_CONFIG — the exit
  // code the runbook documents for a missing DSN is unchanged.
  if (!dsn) throw new Error("config: pass --dsn <odbc dsn> (or set LEGACY_ODBC_DSN), or --fixture <name>");
  return connectOdbc({ dsn, firebirdVersion: args.flags["firebird-version"] });
}

function writeJson(out: string, name: string, value: unknown): string {
  mkdirSync(out, { recursive: true });
  const path = join(out, name);
  writeFileSync(path, [JSON.stringify(value, null, 2), "\n"].join(""), "utf8");
  return path;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log("usage: bun run legacy <scope> [--dsn <dsn> | --fixture <name>] [--firebird-version <v>] [--out <dir>]");
    return 0;
  }
  const out = args.flags.out ?? join("artefacts", "legacy", new Date().toISOString().slice(0, 10));
  // `openDriver` is called INSIDE the try, so a bad --fixture name, a missing --dsn or an unreachable DSN
  // becomes an exit code and not an unhandled rejection. `opened` is a separate `let` read only by the
  // `finally`: the `const driver` below is narrowed to `LegacyDriver` for every branch, so no branch has to
  // re-check it and no branch is renamed as later tasks add commands.
  let opened: LegacyDriver | undefined;
  try {
    const driver = await openDriver(args);
    opened = driver;
    if (args.command === "scope") {
      const report = await scope(driver);
      if (report.engineVersion === null) {
        console.error("config: the engine did not answer ENGINE_VERSION; pass --firebird-version <string> (OD-17, ADR 0081)");
        return EXIT_CONFIG;
      }
      console.log(["engine:", report.engineVersion].join(" "));
      console.log(["tables:", String(report.tables.length), "read,",
        String(report.tables.length - report.unexpectedTables.length), "in the shipped map,",
        String(report.unexpectedTables.length), "unexpected"].join(" "));
      console.log(["rows:", String(report.totalRows)].join(" "));
      console.log(["wrote:", writeJson(out, "scope.json", report)].join(" "));
      return 0;
    }
    console.error(["config: unknown command", args.command].join(" "));
    return EXIT_CONFIG;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(message);
    return message.startsWith("ERR_IMPORT_SOURCE_UNREADABLE") ? EXIT_UNREADABLE : EXIT_CONFIG;
  } finally {
    if (opened) await opened.close();
  }
}

process.exit(await main());
```

**Exit codes, and which failure lands on which.** A corpus name that does not exist raises `ENOENT` from
`readFileSync` — a plain `Error` with no `ERR_` token — so the catch returns **2**, which is the right answer:
a `--fixture` name that is not on disk is a configuration mistake. A missing `--dsn` likewise returns **2**.
A table or column the source does not declare raises `ERR_IMPORT_SOURCE_UNREADABLE` and returns **3**. Task 14
exports `main` (correction C5) and `cli.test.ts` asserts all three.

The `eslint-disable` comment on line 1 is oxlint's `no-console` suppression **for the whole file**, which the
config override at `packages/*/src/cli.ts` (plan0A:301) already grants — the comment is belt-and-braces and
carries its reason, which is the only form §3.2 permits. No new override glob is added.

- [ ] **Step 6: Run the tests and see them pass**

Run: `bun run --cwd packages/importer test`
Expected: PASS. `odbc.test.ts`'s second `describe` reports **skipped** unless `LEGACY_ODBC_DSN` is set.

- [ ] **Step 7: Run the local equivalent end to end**

Run: `bun run legacy scope --fixture base --out artefacts/legacy/dev`
Expected, on stdout:

```
engine: WI-V2.5.9.27139 Firebird 2.5
tables: 3 read, 3 in the shipped map, 0 unexpected
rows: 9
wrote: artefacts/legacy/dev/scope.json
```

and exit code 0 (`echo $?`).

- [ ] **Step 8: Write ADR 0081 — the shell now, the answer when the owner runs Step 9**

`docs/adr/0081-firebird-version-and-extraction-method.md`:

```markdown
# ADR 0081 — Firebird version and extraction method

**Status:** Proposed (accepted when the scoping run has been executed against the live database) ·
**Date:** 2026-09-05 · **Slice:** 9A · **Owner gate:** OD-17 (spec:2409, 2469; Part VII #5)

## Context

Part VII #5 is open: "Firebird version in production. Determines whether the UDF path still works and how data
can be extracted (`gbak` vs ODBC vs direct file read)." Nothing in the shipped files answers it, and contracts
hazard 3 forbids any plan from assuming an answer.

## Options

| Method | What it is | Cost to the owner | Risk |
|---|---|---|---|
| Read the live database over ODBC | a read-only connection to production | none beyond a user account | read load on production during business hours |
| `gbak` backup, restore into a throwaway instance, read that over ODBC | the standard Firebird backup path | one backup window | needs a machine and disk for the restore |
| Copy the `.fdb`, attach it locally, read over ODBC | file copy | a maintenance window (the file must be quiescent) | a copy taken while the engine is writing is not restorable |

**All three terminate at one SQL connection.** The method changes the runbook — who takes the copy, on which
machine, with what downtime — and not `OdbcLegacyDriver`, which is why 9A ships one live driver.

## Decision

- **Extraction method:** _record the method the owner's environment permits, and why._
- **Engine version:** _record the string `rdb$get_context('SYSTEM','ENGINE_VERSION')` returned, or, if the
  engine is older than 2.1 and raised, the version the owner supplied with `--firebird-version`._ Nothing is
  inferred from the ODBC driver string or from the presence of a system table.
- **UDF path:** _record whether the legacy UDF library is still resolvable, since it decides whether stored
  procedures could be run at all — 9A runs none, and 9B must not start._

## Consequences

- Recorded here, consumed by 9B's cut-over runbook.
- If the engine predates 2.1 the version is owner-supplied and this ADR is the only record of it; every
  artefact header carries it, so a report can never be read against the wrong source.
```

- [ ] **Step 9: Run it against the owner's database (OD-17 — this step, and only this step, waits)**

Run: `bun run legacy scope --dsn "$LEGACY_ODBC_DSN" --out artefacts/legacy/scope`
Expected: the same five lines with the owner's numbers, exit 0. Paste the `engine:` line and the three
`Decision` answers into ADR 0081 and change its status to `Accepted`.

**If the engine did not answer:** the command exits 2 with
`config: the engine did not answer ENGINE_VERSION; pass --firebird-version <string> (OD-17, ADR 0081)`. Ask the
owner for the version string, re-run with `--firebird-version "<their answer>"`, and record in ADR 0081 that it
is owner-supplied. **Do not infer it.**

**The artefact is not committed** (`.gitignore` carries `artefacts/`, Task 1). What is committed is ADR 0081.

- [ ] **Step 10: Run the whole gate and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`

```
feat(importer): add the live Firebird driver and the scoping report [9A T3]

OD-17's isolated task (contracts §2.12). One live driver, because all three extraction
methods Part VII #5 lists terminate at one SQL connection; the version is probed and,
where the engine predates 2.1, owner-supplied — never inferred. `scope` answers Part
VII #1 and #2 and §5.1 #10 by counting every table and ranging its dates, and reports
the shipped-map difference in both directions. Runs against the fixture corpus with
`--fixture base` until the owner provides a DSN. ADR 0081.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 4: `LegacyReader` — the §4.13.1 surface 9B consumes — and the error code

**Files:**
- Create: `packages/importer/src/reader.ts`, `packages/importer/src/index.ts`
- Modify: `packages/contracts/src/errors.ts` (one row in `ERRORS`)
- Test: `packages/importer/test/reader.test.ts`

**Interfaces:**
- Consumes: `LegacyDriver`, `unreadable` (T1); `LegacyPredicate` (T1/T2); `FixtureLegacyDriver` (T1).
- Produces — **verbatim from contracts §4.13.1**; every signature below is the contract and may not be altered:
  ```ts
  export interface LegacyReader {
    readonly firebirdVersion: string;
    tables(): Promise<string[]>;
    count(table: string): Promise<number>;
    dateRange(table: string, column: string): Promise<{ min: string | null; max: string | null }>;
    read<T>(table: string, opts: { columns: string[]; where?: LegacyPredicate; batch: number }): AsyncIterable<T[]>;
  }
  export async function createReader(driver: LegacyDriver, declaredVersion?: string): Promise<LegacyReader>;
  ```
  and the package barrel `packages/importer/src/index.ts`, which re-exports `LegacyReader`, `LegacyPredicate`, `createReader`, and — from Tasks 5, 6, 7, 11, 12 and 13 — `profile`, `ProfileReport`, `ProfileOptions`, `reconcile`, `ReconciliationReport` and the rest of §4.13.1's barrel list, to which it never adds a name.

- [ ] **Step 1: Write the failing test**

`packages/importer/test/reader.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

const driver = () => new FixtureLegacyDriver(loadCorpus());

describe("LegacyReader — contracts §4.13.1, the surface 9B consumes unchanged", () => {
  it("carries a non-empty firebirdVersion or refuses to exist", async () => {
    const reader = await createReader(driver());
    expect(reader.firebirdVersion).toBe("WI-V2.5.9.27139 Firebird 2.5");

    const silent = new FixtureLegacyDriver({ ...loadCorpus(), engineVersion: null });
    await expect(createReader(silent)).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: the engine did not report a version; supply one \(OD-17, ADR 0081\)/,
    );
    expect((await createReader(silent, "Firebird 1.5.6")).firebirdVersion).toBe("Firebird 1.5.6");
  });

  it("counts and ranges by table", async () => {
    const reader = await createReader(driver());
    expect(await reader.tables()).toEqual(["ACCOUNTS", "VOUCHERS", "VOUITEMS"]);
    expect(await reader.count("VOUITEMS")).toBe(4);
    expect(await reader.dateRange("VOUCHERS", "DATE")).toEqual({ min: "2024-01-15", max: "2024-03-02" });
  });

  it("reads in batches, filtered by a typed predicate and never by SQL text", async () => {
    const reader = await createReader(driver());
    const seen: Record<string, string | boolean | null>[] = [];
    for await (const rows of reader.read<Record<string, string | boolean | null>>("VOUITEMS", {
      columns: ["ID", "ROW", "DEBIT"],
      where: { op: "eq", column: "ID", value: "2" },
      batch: 1,
    })) {
      expect(rows).toHaveLength(1);
      seen.push(...rows);
    }
    expect(seen).toEqual([
      { ID: "2", ROW: "1", DEBIT: "250.0000" },
      { ID: "2", ROW: "2", DEBIT: "250.0000" },
    ]);
  });

  it("refuses a batch size of zero rather than looping forever", async () => {
    const reader = await createReader(driver());
    const iterate = async () => { for await (const _ of reader.read("VOUITEMS", { columns: ["ID"], batch: 0 })) break; };
    await expect(iterate()).rejects.toThrow(/ERR_IMPORT_SOURCE_UNREADABLE: batch size 0 is not a positive integer/);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test reader`
Expected: FAIL — `Cannot find module '../src/reader'`.

- [ ] **Step 3: Write `packages/importer/src/reader.ts`**

```ts
import type { LegacyPredicate } from "./legacy/predicate";
import { unreadable, type LegacyDriver, type LegacyRow } from "./legacy/types";

/**
 * Contracts §4.13.1, verbatim. 9B consumes this and never redefines it — in particular it calls `read` with a
 * `LegacyPredicate` and never with SQL text. The interface has no catalogue accessor, deliberately: everything
 * above it is a report, and a report that could ask for a column list could also ask for anything else.
 */
export interface LegacyReader {
  readonly firebirdVersion: string;
  tables(): Promise<string[]>;
  count(table: string): Promise<number>;
  dateRange(table: string, column: string): Promise<{ min: string | null; max: string | null }>;
  read<T>(table: string, opts: { columns: string[]; where?: LegacyPredicate; batch: number }): AsyncIterable<T[]>;
}

class DriverReader implements LegacyReader {
  constructor(readonly firebirdVersion: string, private readonly driver: LegacyDriver) {}

  tables(): Promise<string[]> { return this.driver.tables(); }
  count(table: string): Promise<number> { return this.driver.count(table); }
  dateRange(table: string, column: string): Promise<{ min: string | null; max: string | null }> {
    return this.driver.minMax(table, column);
  }

  read<T>(table: string, opts: { columns: string[]; where?: LegacyPredicate; batch: number }): AsyncIterable<T[]> {
    const driver = this.driver;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const rows of driver.cursor({ table, columns: opts.columns, where: opts.where }, opts.batch)) {
          yield rows as unknown as T[];
        }
      },
    };
  }
}

/**
 * `firebirdVersion` is a required non-empty string in §4.13.1, so a reader cannot exist without one. Firebird
 * 2.1 and later answer `rdb$get_context('SYSTEM','ENGINE_VERSION')`; an older engine raises, and then the
 * version is the owner's `--firebird-version` and nothing else. Contracts hazard 3: "the Firebird version is
 * unknown … nothing in 9A/9B assumes gbak, ODBC or a file reader before that ADR." It is never inferred.
 */
export async function createReader(driver: LegacyDriver, declaredVersion?: string): Promise<LegacyReader> {
  const probed = declaredVersion ?? (await driver.engineVersion());
  if (!probed || probed.trim().length === 0) {
    throw unreadable("the engine did not report a version; supply one (OD-17, ADR 0081)");
  }
  return new DriverReader(probed.trim(), driver);
}

export type { LegacyRow };
```

- [ ] **Step 4: Write the barrel `packages/importer/src/index.ts`**

```ts
export { createReader, type LegacyReader } from "./reader";
export type { LegacyPredicate } from "./legacy/predicate";
export type { LegacyColumn, LegacyColumnKind, LegacyDriver, LegacyRow, LegacyScalar, SelectSpec } from "./legacy/types";
export { FixtureLegacyDriver, type LegacyCorpus } from "./drivers/fixture";
export { connectOdbc, OdbcLegacyDriver, redactDsn, type OdbcOptions } from "./drivers/odbc";
export { scope, DATE_COLUMN_CANDIDATES, type ScopeReport, type TableScope } from "./scope";
export { LEGACY_MODULES, ALL_LEGACY_TABLES, moduleOf, type LegacyModule } from "./legacy/modules";
```

**Six later tasks touch this file and no others do:** Task 5 appends two lines (`profile`/`ProfileReport`,
the artefact writer), Task 6 widens Task 5's first line by the type `ProfileOptions`, Task 7 appends two
(`reconcile`/`RECONCILIATION_KINDS`/`ReconciliationReport`, `AGGREGATE_RULES` and its two types), Task 11 one
(the employee-mapping group), Task 12 one (the template-catalogue group) and Task 13 one
(`type LegacyConstraint`). **When Task 13 has run, this file is exactly §4.13.1's barrel list and nothing
more** — the questions probe, the snapshot planner and its column rules, the six reconciliation kinds' own
rule tables and row shapes, the SQL renderer and the CLI's `parseArgs`/`CliArgs`/`main` stay 9A-internal by
that section's closing sentence, and Task 14 therefore adds nothing here. Nothing outside this package imports
`packages/importer/src/**` by a deep path — 9B consumes the barrel.

- [ ] **Step 5: Add the error code to `packages/contracts/src/errors.ts`**

Contracts §4.2.4 already allocates `ERR_IMPORT_SOURCE_UNREADABLE` at status 500 to "Firebird reader (9A)". Add
exactly one row to the `ERRORS` object literal, in the position the file's existing alphabetical-within-domain
grouping puts it (beside the other `ERR_IMPORT_*` allocation if 9B's is already there, otherwise after
`ERR_IDEMPOTENCY_IN_FLIGHT`):

```ts
  ERR_IMPORT_SOURCE_UNREADABLE: { status: 500, title: "The legacy source could not be read",
    remedy: "Check the ODBC DSN and the Firebird engine version, then re-run the extraction (ADR 0081)." },
```

**Why this is safe for the `error-codes` build check (0B, §4.2.4):** the rule fails when a code present in
`ERRORS` has **no** occurrence in `apps/**`, `packages/**/src/**` or `packages/db/migrations/**`. The token
appears in `packages/importer/src/legacy/types.ts` (`unreadable`), in `drivers/sql.ts`, `drivers/odbc.ts`,
`reader.ts` and `cli.ts` — all inside `packages/**/src/**` — so the check is satisfied the moment this row
lands. No other row in that file changes.

- [ ] **Step 6: Run the tests and see them pass**

Run: `bun run --cwd packages/importer test && bun run --cwd packages/contracts test`
Expected: PASS in both. The contracts package's own error-registry test (0B) counts rows; if it pins a count,
update the pinned number to include this one code and nothing else.

- [ ] **Step 7: Run the whole gate and commit**

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green, including `error-codes`, which now sees a raise site for the new code.

```
feat(importer): implement LegacyReader verbatim from contracts §4.13.1 [9A T4]

The surface 9B consumes unchanged: tables, count, dateRange and a batched read whose
`where` is a typed LegacyPredicate. `firebirdVersion` is required, so a reader cannot
exist without one — probed from ENGINE_VERSION on Firebird 2.1+, owner-supplied below
that, never inferred (hazard 3). Adds ERR_IMPORT_SOURCE_UNREADABLE to the ERRORS
registry, which contracts §4.2.4 already allocates to this slice.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 5: `profile`, the artefact writer, and ADR 0083

**Files:**
- Create: `packages/importer/src/profile.ts`, `packages/importer/src/artefacts.ts`, `docs/adr/0083-legacy-artefact-format-and-anonymisation.md`
- Modify: `packages/importer/src/cli.ts` (the `profile` command), `packages/importer/src/index.ts` (two exports)
- Test: `packages/importer/test/profile.test.ts`

**Interfaces:**
- Consumes: `LegacyReader` (T4), `LEGACY_MODULES`/`moduleOf`/`ALL_LEGACY_TABLES` (T1), `DATE_COLUMN_CANDIDATES` (T3).
- Produces — the two §4.13.1 shapes verbatim, plus the writer:
  ```ts
  export interface ProfileReport {
    generatedAt: string;
    tables: { name: string; rows: number; dateRange?: { min: string | null; max: string | null } }[];
    modulesInUse: Record<string, boolean>;
  }
  export async function profile(reader: LegacyReader): Promise<ProfileReport>;
  // packages/importer/src/artefacts.ts
  export interface ArtefactEntry { readonly name: string; readonly kind: string; readonly rows: number; readonly bytes: number; readonly sha256: string }
  export interface ArtefactIndex { readonly generatedAt: string; readonly source: string; readonly engineVersion: string; readonly artefacts: readonly ArtefactEntry[] }
  export class ReportWriter {
    constructor(outDir: string, header: { source: string; engineVersion: string });
    json(name: string, value: unknown, rows: number): ArtefactEntry;
    csv(name: string, rows: readonly Record<string, unknown>[]): ArtefactEntry;
    bytes(name: string, content: Buffer): ArtefactEntry;
    finish(): ArtefactIndex;
  }
  export function toCsv(rows: readonly Record<string, unknown>[]): string;
  ```

- [ ] **Step 1: Write the failing test**

`packages/importer/test/profile.test.ts`:

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportWriter, toCsv } from "../src/artefacts";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { profile } from "../src/profile";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

describe("profile — contracts §4.13.1 and Part VII #1", () => {
  it("returns the frozen shape: generatedAt, tables with optional ranges, modulesInUse", async () => {
    const report = await profile(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(Object.keys(report).sort()).toEqual(["generatedAt", "modulesInUse", "tables"]);
    expect(report.tables).toEqual([
      { name: "ACCOUNTS", rows: 3 },
      { name: "VOUCHERS", rows: 2, dateRange: { min: "2024-01-15", max: "2024-03-02" } },
      { name: "VOUITEMS", rows: 4 },
    ]);
  });

  it("answers 'which modules are actually used' — a module is in use when any of its tables has a row", async () => {
    const report = await profile(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(report.modulesInUse.standard).toBe(true);
    expect(report.modulesInUse.hospitals).toBe(false);
    expect(report.modulesInUse.academy).toBe(false);
    expect(report.modulesInUse.salaries).toBe(false);
    // Every one of the seventeen is answered, so an absent key can never be read as "unknown".
    expect(Object.keys(report.modulesInUse)).toHaveLength(17);
  });

  it("omits dateRange rather than reporting a null range for a table with no date column", async () => {
    const report = await profile(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(report.tables.find((t) => t.name === "ACCOUNTS")).not.toHaveProperty("dateRange");
  });
});

describe("ReportWriter — ADR 0083", () => {
  it("writes JSON and CSV, hashes each artefact, and indexes them", () => {
    const dir = mkdtempSync(join(tmpdir(), "dulja-9a-"));
    const writer = new ReportWriter(dir, { source: "fixture corpus", engineVersion: "Firebird 2.5" });
    writer.json("profile.json", { ok: true }, 1);
    writer.csv("drift.csv", [{ table: "ACCTOTALS", stored: "100.0000", recomputed: "90.0000" }]);
    const index = writer.finish();

    expect(index.artefacts.map((a) => a.name)).toEqual(["profile.json", "drift.csv", "index.json"]);
    expect(index.artefacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(index.artefacts[1]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // index.json lists itself with an empty digest: a file cannot carry the hash of its own final bytes.
    expect(index.artefacts[2]).toEqual({ name: "index.json", kind: "json", rows: 2, bytes: 0, sha256: "" });
    expect(index.engineVersion).toBe("Firebird 2.5");
    expect(readFileSync(join(dir, "drift.csv"), "utf8")).toBe(
      "﻿table,stored,recomputed\r\nACCTOTALS,100.0000,90.0000\r\n",
    );
    // The file on disk is the value `finish()` returned, not one entry short of it.
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8"))).toEqual(index);
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).artefacts).toHaveLength(3);
  });

  it("escapes CSV per RFC 4180 so an Arabic name with a comma cannot shift a column", () => {
    expect(toCsv([{ name: 'محمد, "أحمد"', note: "line\nbreak" }]))
      .toBe('﻿name,note\r\n"محمد, ""أحمد""","line\nbreak"\r\n');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test profile`
Expected: FAIL — `Cannot find module '../src/artefacts'`.

- [ ] **Step 3: Write `packages/importer/src/artefacts.ts`**

```ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ArtefactEntry { readonly name: string; readonly kind: string; readonly rows: number; readonly bytes: number; readonly sha256: string }
export interface ArtefactIndex { readonly generatedAt: string; readonly source: string; readonly engineVersion: string; readonly artefacts: readonly ArtefactEntry[] }

/**
 * RFC 4180, with a UTF-8 BOM. The BOM is not decoration: these files carry Arabic master-data names, and
 * Excel on Windows — which is what the owner will open them in — decodes a BOM-less UTF-8 CSV as the system
 * code page and renders every Arabic name as mojibake. LEGACY-085 is the same defect in the other direction.
 */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "﻿";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (value: unknown): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(s) ? ['"', s.replace(/"/g, '""'), '"'].join("") : s;
  };
  const lines = [headers.map(cell).join(","), ...rows.map((r) => headers.map((h) => cell(r[h])).join(","))];
  return ["﻿", lines.join("\r\n"), "\r\n"].join("");
}

/**
 * Every artefact this slice produces is written twice — machine-readable JSON and a CSV the owner's accountant
 * can open — and hashed, and listed in `index.json`. The hash is what lets 9B's cut-over runbook say "the
 * reconciliation the owner signed off is exactly this file" months later (ADR 0083).
 */
export class ReportWriter {
  private readonly entries: ArtefactEntry[] = [];
  private readonly generatedAt = [new Date().toISOString().slice(0, 19), "Z"].join("");

  constructor(private readonly outDir: string, private readonly header: { source: string; engineVersion: string }) {
    mkdirSync(outDir, { recursive: true });
  }

  json(name: string, value: unknown, rows: number): ArtefactEntry {
    return this.write(name, "json", rows, Buffer.from([JSON.stringify(value, null, 2), "\n"].join(""), "utf8"));
  }

  csv(name: string, rows: readonly Record<string, unknown>[]): ArtefactEntry {
    return this.write(name, "csv", rows.length, Buffer.from(toCsv(rows), "utf8"));
  }

  bytes(name: string, content: Buffer): ArtefactEntry {
    return this.write(name, "blob", 1, content);
  }

  /**
   * Writes `index.json` last, listing itself, and returns exactly what it wrote — the returned object and the
   * file on disk are the same value, which is the property that lets a later task cite the file instead of a
   * log line. Its own entry carries `bytes: 0` and `sha256: ""` because a file cannot contain the digest of
   * its own final bytes; `rows` is the number of artefacts indexed beside it. Every *other* entry is hashed
   * over exactly the bytes that were written. `finish` does not go through `write`, so it never appends its
   * own entry to `entries` and calling it twice produces the same index rather than a growing one.
   */
  finish(): ArtefactIndex {
    const self: ArtefactEntry = { name: "index.json", kind: "json", rows: this.entries.length, bytes: 0, sha256: "" };
    const index: ArtefactIndex = {
      generatedAt: this.generatedAt, source: this.header.source, engineVersion: this.header.engineVersion,
      artefacts: [...this.entries, self],
    };
    writeFileSync(join(this.outDir, "index.json"), Buffer.from([JSON.stringify(index, null, 2), "\n"].join(""), "utf8"));
    return index;
  }

  private write(name: string, kind: string, rows: number, content: Buffer): ArtefactEntry {
    writeFileSync(join(this.outDir, name), content);
    const entry: ArtefactEntry = { name, kind, rows, bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") };
    this.entries.push(entry);
    return entry;
  }
}
```

- [ ] **Step 4: Write `packages/importer/src/profile.ts`**

```ts
import { LEGACY_MODULES, moduleOf } from "./legacy/modules";
import type { LegacyReader } from "./reader";
import { DATE_COLUMN_CANDIDATES } from "./scope";

/** Contracts §4.13.1, verbatim — mutable members and optional `dateRange` included. */
export interface ProfileReport {
  generatedAt: string;
  tables: { name: string; rows: number; dateRange?: { min: string | null; max: string | null } }[];
  modulesInUse: Record<string, boolean>;
}

/**
 * Part VII #1: "Which modules are actually used? 460 tables is the shipped surface. Run row counts per table
 * against the live database. The hospital (50 tables), academy (44), and aviation modules may be entirely dead
 * weight — this could halve the rebuild." (spec:2465)
 *
 * `LegacyReader` has no catalogue accessor — §4.13.1 froze it without one — so the date range is found by
 * asking for each candidate column in turn and keeping the first that answers. A column the table does not
 * have raises `ERR_IMPORT_SOURCE_UNREADABLE` from the driver, which is caught here and means "not this one".
 * `dateRange` is then **omitted**, never set to `{ min: null, max: null }`: an absent property says "this table
 * has no business date", a null range would say "it has one and it is empty", and the two are different
 * answers to Part VII #2.
 */
export async function profile(reader: LegacyReader): Promise<ProfileReport> {
  const names = await reader.tables();
  const tables: ProfileReport["tables"] = [];
  const modulesInUse: Record<string, boolean> = Object.fromEntries(LEGACY_MODULES.map((m) => [m.id, false]));

  for (const name of names) {
    const rows = await reader.count(name);
    const module = moduleOf(name);
    if (module && rows > 0) modulesInUse[module.id] = true;

    const range = rows > 0 ? await firstRange(reader, name) : undefined;
    tables.push(range ? { name, rows, dateRange: range } : { name, rows });
  }

  return { generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""), tables, modulesInUse };
}

async function firstRange(
  reader: LegacyReader, table: string,
): Promise<{ min: string | null; max: string | null } | undefined> {
  for (const column of DATE_COLUMN_CANDIDATES) {
    try {
      const range = await reader.dateRange(table, column);
      if (range.min !== null || range.max !== null) return range;
    } catch {
      // Not a column of this table. Try the next candidate.
    }
  }
  return undefined;
}
```

- [ ] **Step 5: Add the `profile` command to the CLI**

In `packages/importer/src/cli.ts`, add the imports and one branch inside `main`'s `try`, after the `scope` branch:

```ts
    if (args.command === "profile") {
      const reader = await createReader(driver, args.flags["firebird-version"]);
      const report = await profile(reader);
      const writer = new ReportWriter(out, { source: driver.source, engineVersion: reader.firebirdVersion });
      writer.json("profile.json", report, report.tables.length);
      writer.csv("profile.csv", report.tables.map((t) => ({
        table: t.name, module: moduleOf(t.name)?.id ?? "", rows: t.rows,
        date_min: t.dateRange?.min ?? "", date_max: t.dateRange?.max ?? "",
      })));
      const index = writer.finish();
      const used = Object.entries(report.modulesInUse).filter(([, v]) => v).map(([k]) => k);
      console.log(["engine:", reader.firebirdVersion].join(" "));
      console.log(["tables:", String(report.tables.length)].join(" "));
      console.log(["modules in use:", used.join(", ") || "(none)"].join(" "));
      console.log(["wrote:", index.artefacts.map((a) => a.name).join(", "), "->", out].join(" "));
      return 0;
    }
```

with `import { profile } from "./profile";`, `import { ReportWriter } from "./artefacts";`, `import { createReader } from "./reader";` and `import { moduleOf } from "./legacy/modules";` at the top, and the usage line widened to
`usage: bun run legacy <scope|profile> …`.

- [ ] **Step 6: Add the two exports to the barrel**

In `packages/importer/src/index.ts`:

```ts
export { profile, type ProfileReport } from "./profile";
export { ReportWriter, toCsv, type ArtefactEntry, type ArtefactIndex } from "./artefacts";
```

§4.13.1's barrel paragraph lists `profile`, `ProfileReport` **and `ProfileOptions`** together; the third name
does not exist until Task 6 declares it, so **Task 6 Step 6 widens the first line** rather than adding a second
one. If Task 6 is dropped (the OD-16 gate is droppable), fold that one word into this line instead and declare
`export interface ProfileOptions { readonly includeMpos?: boolean }` at the top of `profile.ts` with the
parameter accepted and ignored — the registry member is not optional even when the POS decision is unmade.

- [ ] **Step 7: Run the tests and see them pass**

Run: `bun run --cwd packages/importer test`
Expected: PASS — five new cases (three `profile`, two `ReportWriter`).

Then run the command against the corpus:

Run: `bun run legacy profile --fixture base --out artefacts/legacy/dev`
Expected:

```
engine: WI-V2.5.9.27139 Firebird 2.5
tables: 3
modules in use: standard
wrote: profile.json, profile.csv, index.json -> artefacts/legacy/dev
```

- [ ] **Step 8: Write ADR 0083**

`docs/adr/0083-legacy-artefact-format-and-anonymisation.md`:

```markdown
# ADR 0083 — Legacy artefacts: format, hashing, and what may leave the customer's machine

**Status:** Accepted · **Date:** 2026-09-05 · **Slice:** 9A

## Context

This slice produces a dozen reports the owner and their accountant must read, argue about, and later point at
("the reconciliation we signed off"). It also produces the anonymised snapshot spec:2272 requires for staging.
None of it is a database row: contracts §4.11's `ReportDefinition` is Phase 7's engine over `report_definition`,
and nothing here is per-tenant data in Dulja — it is customer data from a system Dulja is replacing.

## Decision

1. **Every artefact is written twice**: `<name>.json` (machine-readable, the shape a later task consumes) and
   `<name>.csv` (UTF-8 **with a BOM**, RFC 4180, so Excel on Windows renders Arabic master-data names instead
   of mojibake — LEGACY-085 in reverse).
2. **Every artefact is hashed with sha256 and listed in `index.json`**, which also carries `generatedAt` (UTC,
   to the second), the redacted `source` and the `engineVersion`. A report can never be read against the wrong
   source or the wrong engine, and 9B's cut-over runbook can cite a hash. `index.json` **lists itself** so the
   file is a complete manifest of the run, and its own entry carries `bytes: 0` and an **empty** `sha256`,
   because a file cannot contain the digest of its own final bytes. Whoever needs to pin the manifest itself
   hashes `index.json` externally; every artefact listed inside it carries a real digest.
3. **Artefacts are written under `artefacts/legacy/<name>/` and are never committed** — `.gitignore` carries
   `artefacts/`. They contain customer data.
4. **No credential ever reaches an artefact or a log line.** `redactDsn` replaces `UID`/`PWD`/`USER`/`PASSWORD`
   values with `***` before the DSN is stored in any header (spec:2063's forbidden-field rule, extended to this
   package by hand because `forbidden-log-fields` inspects logger call objects and this is a plain string).
5. **The anonymisation rule for the staging snapshot** (Task 14): every column classified as a personal
   identifier is replaced by a deterministic pseudonym `HMAC-SHA256(salt, table||column||value)` truncated to
   the column's declared width, with a per-run random salt that is **not** written to the artefact directory —
   so the mapping cannot be reversed from the snapshot, and two rows that shared a value still share one.
   `Users.Password` and `Users.PIN` are on a **deny-list**: they are not pseudonymised, they are never read.

## Consequences

- A later phase that wants one of these numbers inside Dulja must load it as data through 9B; nothing here
  becomes a `report_definition`, a `DatasetId` or a route.
- The CSV's BOM makes the files unusable as input to a naïve UTF-8 parser. The JSON is the machine input; the
  CSV is for a person.
```

- [ ] **Step 9: Run the whole gate and commit**

```
feat(importer): profile the legacy database and write hashed artefacts [9A T5]

profile() is contracts §4.13.1 verbatim and answers Part VII #1 — a module is in use
when any of its tables has a row, and all seventeen are answered so an absent key can
never be read as "unknown". Every artefact is written as JSON and as BOM'd RFC 4180
CSV, hashed, and indexed with the redacted source and the engine version. ADR 0083.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 6: OWNER GATE OD-16 — whether the `mpos` schema is read at all

> **This task is isolated (contracts §2.0, §2.12).** OD-16 is Part VII #10 ⚠️ — "Must historical POS *data*
> migrate? … whether past tickets in the old `mpos` schema need to come across, or whether the new POS starts
> clean at cut-over with only the catalogue. Starting clean is far cheaper; confirm it is acceptable"
> (spec:2474). The §2.12 default is **start clean**, so **`mposStandard` and `mposSystem` are not read** and no
> other task in this plan touches them. Drop this task and that default simply stands.
>
> **Owner provides (OD-16):** the answer, and — only if it is *yes* — a second read-only ODBC DSN for the POS
> database. Nothing else changes: the `mpos` schema is deliberately separate (analysis §4.3), so it is a second
> connection, never a second table list on the first one.
>
> **Verify:** `bun run legacy scope --dsn "$LEGACY_ODBC_DSN" --mpos-dsn "$LEGACY_MPOS_DSN" --out artefacts/legacy/mpos`
> prints `mpos: present, <n> tables, <r> ticket rows, <min>..<max>` and writes `mpos-decision.json`. **Both
> DSNs are required:** `openDriver` runs before any command branch and, with neither `--fixture` nor `--dsn`,
> falls back to `LEGACY_ODBC_DSN` and exits 2 when that is unset — so the `--mpos-dsn` block inside the `scope`
> branch is never reached by `--mpos-dsn` alone. The two databases are two connections (assumption 13), and
> this command opens both.
>
> **Until answered:** `bun run legacy scope --fixture base` prints `mpos: not read (OD-16 default: start clean)`
> and writes nothing about POS. **This plan does not decide OD-16** — Step 4's artefact carries the numbers and
> the question, and no verdict field.

**Files:**
- Create: `packages/importer/src/mpos.ts`
- Modify: `packages/importer/src/cli.ts` (`--mpos-dsn`, `--include-mpos`), `packages/importer/src/profile.ts` (one filter plus `ProfileOptions`), `packages/importer/src/index.ts` (**Step 6** — widen Task 5's `./profile` line by the type `ProfileOptions`; nothing from `mpos.ts` crosses the barrel)
- Test: `packages/importer/test/mpos-scope.test.ts`, `packages/importer/test/corpus/mpos/*` (a second corpus)

**Interfaces:**
- Consumes: `LegacyReader` (T4), `LEGACY_MODULES`/`moduleOf` (T1), `ReportWriter` (T5).
- Produces:
  ```ts
  export const MPOS_MODULE_IDS: readonly ["mposstandard", "mpossystem"];
  export function isMposTable(table: string): boolean;
  export interface MposDecisionReport {
    readonly generatedAt: string; readonly source: string; readonly present: boolean;
    readonly tables: readonly { table: string; rows: number; dateRange: { min: string | null; max: string | null } | null }[];
    readonly ticketRows: number;
    readonly ticketDateRange: { min: string | null; max: string | null } | null;
    readonly question: string;         // Part VII #10, verbatim
    readonly answer: null;             // this plan decides nothing (contracts hazard 7)
  }
  export async function mposDecision(reader: LegacyReader): Promise<MposDecisionReport>;
  ```

- [ ] **Step 1: Add the second fixture corpus**

`packages/importer/test/corpus/mpos/catalog.json`:

```json
{
  "engineVersion": "WI-V2.5.9.27139 Firebird 2.5",
  "tables": {
    "POSTICKETS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "DATE", "kind": "timestamp", "scale": 0, "nullable": true },
        { "name": "TOTAL", "kind": "decimal", "scale": 4, "nullable": true }
      ]
    },
    "POSENTRIES": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "DATE", "kind": "timestamp", "scale": 0, "nullable": true }
      ]
    }
  }
}
```

`packages/importer/test/corpus/mpos/POSTICKETS.json`:

```json
[
  { "SITE": "1", "ID": "1", "DATE": "2023-11-04 08:15:00.0000", "TOTAL": "18.5000" },
  { "SITE": "1", "ID": "2", "DATE": "2024-05-20 19:02:11.0000", "TOTAL": "42.0000" }
]
```

`packages/importer/test/corpus/mpos/POSENTRIES.json`:

```json
[{ "SITE": "1", "ID": "1", "DATE": "2023-11-04 08:15:00.0000" }]
```

- [ ] **Step 2: Write the failing test**

`packages/importer/test/mpos-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { isMposTable, mposDecision, MPOS_MODULE_IDS } from "../src/mpos";
import { profile } from "../src/profile";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

describe("OD-16 — whether the mpos schema is read at all (Part VII #10)", () => {
  it("names the two POS databases and nothing else", () => {
    expect([...MPOS_MODULE_IDS]).toEqual(["mposstandard", "mpossystem"]);
    expect(isMposTable("POSTICKETS")).toBe(true);
    expect(isMposTable("POSENTRYITEMS")).toBe(true);
    expect(isMposTable("VOUITEMS")).toBe(false);
    // A `pos`-prefixed name that is not in the shipped map is NOT assumed to be POS: the map decides.
    expect(isMposTable("POSSIBLE_CUSTOM_TABLE")).toBe(false);
  });

  it("profile excludes POS tables from the main database unless asked", async () => {
    const merged = { ...loadCorpus(), tables: { ...loadCorpus().tables, ...loadCorpus("mpos").tables } };
    const reader = await createReader(new FixtureLegacyDriver(merged));
    expect((await profile(reader)).tables.map((t) => t.name)).toEqual(["ACCOUNTS", "VOUCHERS", "VOUITEMS"]);
    expect((await profile(reader, { includeMpos: true })).tables.map((t) => t.name))
      .toEqual(["ACCOUNTS", "POSENTRIES", "POSTICKETS", "VOUCHERS", "VOUITEMS"]);
  });

  it("produces the decision input and no verdict", async () => {
    const report = await mposDecision(await createReader(new FixtureLegacyDriver(loadCorpus("mpos"))));
    expect(report.present).toBe(true);
    expect(report.ticketRows).toBe(2);
    expect(report.ticketDateRange).toEqual({ min: "2023-11-04 08:15:00.0000", max: "2024-05-20 19:02:11.0000" });
    expect(report.tables).toEqual([
      { table: "POSENTRIES", rows: 1, dateRange: { min: "2023-11-04 08:15:00.0000", max: "2023-11-04 08:15:00.0000" } },
      { table: "POSTICKETS", rows: 2, dateRange: { min: "2023-11-04 08:15:00.0000", max: "2024-05-20 19:02:11.0000" } },
    ]);
    expect(report.answer).toBeNull();
    expect(report.question).toContain("Must historical POS");
  });

  it("says so plainly when there is no POS data at all", async () => {
    const report = await mposDecision(await createReader(new FixtureLegacyDriver(loadCorpus())));
    expect(report.present).toBe(false);
    expect(report.ticketRows).toBe(0);
    expect(report.tables).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `bun run --cwd packages/importer test mpos`
Expected: FAIL — `Cannot find module '../src/mpos'`.

- [ ] **Step 4: Write `packages/importer/src/mpos.ts`**

```ts
import { moduleOf } from "./legacy/modules";
import type { LegacyReader } from "./reader";

/** The two shipped POS databases. `mpos` is "a deliberately separate schema" (analysis §4.3), so these are a
 *  second connection, not a second table list on the first. */
export const MPOS_MODULE_IDS = ["mposstandard", "mpossystem"] as const;

/** Membership in the shipped map decides — never the `pos` prefix, which a customisation may also carry. */
export function isMposTable(table: string): boolean {
  const module = moduleOf(table);
  return module !== undefined && (MPOS_MODULE_IDS as readonly string[]).includes(module.id);
}

export interface MposDecisionReport {
  readonly generatedAt: string;
  readonly source: string;
  readonly present: boolean;
  readonly tables: readonly { table: string; rows: number; dateRange: { min: string | null; max: string | null } | null }[];
  readonly ticketRows: number;
  readonly ticketDateRange: { min: string | null; max: string | null } | null;
  readonly question: string;
  /** Always null. Contracts hazard 7: a plan needing a decision writes the input and stops. */
  readonly answer: null;
}

const QUESTION =
  "Must historical POS data migrate? The POS application itself is being rebuilt. The open question is whether " +
  "past tickets in the old mpos schema need to come across, or whether the new POS starts clean at cut-over " +
  "with only the catalogue. Starting clean is far cheaper; confirm it is acceptable. (spec:2474, Part VII #10, OD-16)";

/** Depth and volume of the legacy till history, with the question restated and no recommendation attached. */
export async function mposDecision(reader: LegacyReader): Promise<MposDecisionReport> {
  const names = (await reader.tables()).filter(isMposTable).sort();
  const tables: MposDecisionReport["tables"] = [];
  for (const table of names) {
    const rows = await reader.count(table);
    let dateRange: { min: string | null; max: string | null } | null = null;
    if (rows > 0) {
      try { dateRange = await reader.dateRange(table, "DATE"); } catch { dateRange = null; }
    }
    tables.push({ table, rows, dateRange });
  }
  const tickets = tables.find((t) => t.table === "POSTICKETS");
  return {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: "", present: tables.some((t) => t.rows > 0), tables,
    ticketRows: tickets?.rows ?? 0, ticketDateRange: tickets?.dateRange ?? null,
    question: QUESTION, answer: null,
  };
}
```

`source` is filled by the caller (the CLI has the driver; `mposDecision` has only the reader, which §4.13.1
gives no `source`). The CLI writes `{ ...report, source: driver.source }` — one spread, no interface change.

- [ ] **Step 5: Filter POS tables out of `profile`**

In `packages/importer/src/profile.ts`, widen the signature by one **optional** parameter — additive, so every
existing call site is unchanged. Add `export interface ProfileOptions` above the function and replace the
function's first two lines; the loop body and the return statement Task 5 wrote are untouched. The whole
function, as it stands after this edit, is:

```ts
export interface ProfileOptions { readonly includeMpos?: boolean }

export async function profile(reader: LegacyReader, opts: ProfileOptions = {}): Promise<ProfileReport> {
  const all = await reader.tables();
  const names = opts.includeMpos ? all : all.filter((t) => !isMposTable(t));
  const tables: ProfileReport["tables"] = [];
  const modulesInUse: Record<string, boolean> = Object.fromEntries(LEGACY_MODULES.map((m) => [m.id, false]));

  for (const name of names) {
    const rows = await reader.count(name);
    const module = moduleOf(name);
    if (module && rows > 0) modulesInUse[module.id] = true;

    const range = rows > 0 ? await firstRange(reader, name) : undefined;
    tables.push(range ? { name, rows, dateRange: range } : { name, rows });
  }

  return { generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""), tables, modulesInUse };
}
```

with `import { isMposTable } from "./mpos";` added to the file's imports. `firstRange` below it does not
change. The default is OD-16's default: **start clean, so do not read it.** Note that `modulesInUse` still
answers all seventeen modules including `mposstandard`/`mpossystem` — they answer `false` when the POS tables
are filtered out, which is the honest reading of "not read", and the CLI's `mpos:` line is what says so.

- [ ] **Step 6: Add `ProfileOptions` to the barrel**

`ProfileOptions` is a **frozen §4.13.1 member** — its barrel paragraph lists "`profile`, `ProfileReport`,
`ProfileOptions`" — and Task 5's line exported only the first two because the type did not exist yet. Widen
that line in `packages/importer/src/index.ts` so 9B's `import type { ProfileOptions } from "@dulja/importer";`
compiles:

```ts
export { profile, type ProfileOptions, type ProfileReport } from "./profile";
```

That is this task's **only** edit to the barrel. `MPOS_MODULE_IDS`, `isMposTable`, `mposDecision` and
`MposDecisionReport` are **not** exported from it: §4.13.1's barrel list does not name them, and its closing
sentence puts everything it does not name inside 9A ("Everything else under `packages/importer/src/**` is
internal to 9A … and no slice imports them"). `profile.ts` and `cli.ts` reach them by the relative path
`./mpos`, and `test/mpos-scope.test.ts` by `../src/mpos`.

- [ ] **Step 7: Wire the CLI**

In `packages/importer/src/cli.ts`, inside the `scope` branch, after the four existing `console.log` lines:

```ts
      const mposDsn = args.flags["mpos-dsn"];
      if (!mposDsn) {
        console.log("mpos: not read (OD-16 default: start clean)");
      } else {
        const mposDriver = await connectOdbc({ dsn: mposDsn, firebirdVersion: args.flags["firebird-version"] });
        try {
          const mposReader = await createReader(mposDriver, args.flags["firebird-version"]);
          const decision = { ...(await mposDecision(mposReader)), source: mposDriver.source };
          const range = decision.ticketDateRange;
          console.log(["mpos:", decision.present ? "present," : "empty,", String(decision.tables.length), "tables,",
            String(decision.ticketRows), "ticket rows,", range ? [range.min, range.max].join("..") : "no range"].join(" "));
          console.log(["wrote:", writeJson(out, "mpos-decision.json", decision)].join(" "));
        } finally {
          await mposDriver.close();
        }
      }
```

and add `--include-mpos` to the `profile` branch: `await profile(reader, { includeMpos: args.switches.has("include-mpos") })`.
Widen the usage line to mention `[--mpos-dsn <dsn>] [--include-mpos]`.

- [ ] **Step 8: Run the tests, the command, the gate, and commit**

Run: `bun run --cwd packages/importer test` → PASS (four new cases).
Run: `bun run legacy scope --fixture base --out artefacts/legacy/dev` → the four earlier lines plus
`mpos: not read (OD-16 default: start clean)`.
Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green — `typecheck` in particular now resolves `ProfileOptions` through the barrel.

```
feat(importer): isolate the OD-16 decision about the mpos schema [9A T6]

Part VII #10 is unanswered, and the §2.12 default is to start clean — so the POS
databases are not read: `profile` filters them out unless --include-mpos, and the
second DSN is only opened when the owner supplies --mpos-dsn. mposDecision reports
the depth and volume of the legacy till history with the question restated verbatim
and an `answer` that is always null; this plan decides nothing (hazard 7).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 7: `reconcile`, the declarative aggregate table, and the drift report (§5.1 #1)

**Files:**
- Create: `packages/importer/src/legacy/aggregates.ts`, `packages/importer/src/reconcile/index.ts`, `packages/importer/src/reconcile/probe.ts`, `packages/importer/src/reconcile/aggregate-drift.ts`
- Modify: `packages/importer/src/cli.ts` (the `reconcile` command), `packages/importer/src/index.ts` (two exports), `packages/importer/test/corpus/base/catalog.json` (add `ACCTOTALS`, `ACCOBJECTS`), `packages/importer/test/profile.test.ts` and `packages/importer/test/scope.test.ts` (**correction C1**, in Step 1)
- Create: `packages/importer/test/corpus/base/ACCTOTALS.json`, `packages/importer/test/corpus/base/ACCOBJECTS.json`
- Test: `packages/importer/test/aggregate-drift.test.ts`

**Interfaces:**
- Consumes: `LegacyReader` (T4), `ReportWriter` (T5), `Decimal` from `decimal.js`.
- Produces:
  ```ts
  // packages/importer/src/legacy/aggregates.ts
  export type AggregateConfidence = "verified" | "hypothesis" | "not_derivable";
  export interface AggregateRule {
    readonly id: string;                      // "ACCTOTALS.DEBIT"
    readonly storedTable: string; readonly storedColumn: string; readonly storedKey: readonly string[];
    readonly sourceTable: string | null; readonly sourceColumn: string | null; readonly sourceKey: readonly string[];
    readonly confidence: AggregateConfidence;
    readonly derivation: string;              // printed on every row of the report
    readonly legacyDefects: readonly string[];
  }
  export const AGGREGATE_RULES: readonly AggregateRule[];
  // packages/importer/src/reconcile/probe.ts
  export async function hasColumns(reader: LegacyReader, table: string, columns: readonly string[]): Promise<boolean>;
  // packages/importer/src/reconcile/index.ts  — contracts §4.13.1, verbatim
  export interface ReconciliationReport {
    kind: "aggregate_drift" | "unbalanced_vouchers" | "orphans" | "null_poison" | "duplicate_aggregates" | "employee_mapping";
    rows: Record<string, unknown>[];
    summary: Record<string, string>;
  }
  export async function reconcile(reader: LegacyReader, kind: ReconciliationReport["kind"]): Promise<ReconciliationReport>;
  export const RECONCILIATION_KINDS: readonly ReconciliationReport["kind"][];
  // packages/importer/src/reconcile/aggregate-drift.ts
  export async function aggregateDrift(reader: LegacyReader): Promise<ReconciliationReport>;
  export const READ_BATCH: number;            // 5_000
  ```

- [ ] **Step 1: Extend the corpus with the two stored aggregates**

Add to `packages/importer/test/corpus/base/catalog.json`'s `tables` object:

```json
    "ACCTOTALS": {
      "keyColumns": ["ACCOUNT"],
      "columns": [
        { "name": "ACCOUNT", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "DEBIT", "kind": "decimal", "scale": 4, "nullable": true },
        { "name": "CREDIT", "kind": "decimal", "scale": 4, "nullable": true },
        { "name": "ADMINDEBIT", "kind": "decimal", "scale": 4, "nullable": true },
        { "name": "ADMINCREDIT", "kind": "decimal", "scale": 4, "nullable": true }
      ]
    },
    "ACCOBJECTS": {
      "keyColumns": ["SITE", "ACCOUNT"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ACCOUNT", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "DEBIT", "kind": "decimal", "scale": 4, "nullable": true },
        { "name": "CREDIT", "kind": "decimal", "scale": 4, "nullable": true },
        { "name": "OPENDEBIT", "kind": "decimal", "scale": 4, "nullable": true },
        { "name": "OPENCREDIT", "kind": "decimal", "scale": 4, "nullable": true }
      ]
    }
```

`packages/importer/test/corpus/base/ACCTOTALS.json` — account 10 is **wrong on purpose** (the corpus's
`VOUITEMS` sum 350.0000, the aggregate says 300.0000: LEGACY-001/002 drift), account 11 is right:

```json
[
  { "ACCOUNT": "10", "DEBIT": "300.0000", "CREDIT": "0.0000", "ADMINDEBIT": "0.0000", "ADMINCREDIT": "0.0000" },
  { "ACCOUNT": "11", "DEBIT": "250.0000", "CREDIT": "100.0000", "ADMINDEBIT": "0.0000", "ADMINCREDIT": "0.0000" }
]
```

`packages/importer/test/corpus/base/ACCOBJECTS.json` — and here the row for `(1, 11)` is **missing** entirely,
which is the other half of the same defect class (a decrement that never fired):

```json
[
  { "SITE": "1", "ACCOUNT": "10", "DEBIT": "350.0000", "CREDIT": "0.0000", "OPENDEBIT": null, "OPENCREDIT": null }
]
```

**Correction C1 — apply it in this step, before running anything.** This is the first task that grows
`test/corpus/base/`, and **five** suites written earlier pin the corpus's size or its exact table list rather
than the behaviour they are about: `fixture-driver.test.ts` (T1), `scope.test.ts` (T3), `reader.test.ts` (T4),
`profile.test.ts` (T5) and `mpos-scope.test.ts` (T6). Adding `ACCTOTALS` and `ACCOBJECTS` turns all five red
for a reason that has nothing to do with the driver, the reader, the scoper or the profiler, and Tasks 9, 10,
11 and 12 each add another table. Make all five growth-proof here, once. Every edit below is idempotent — if
you find one already applied, move on.

In `packages/importer/test/fixture-driver.test.ts`, replace

```ts
    expect(await driver.tables()).toEqual(["ACCOUNTS", "VOUCHERS", "VOUITEMS"]);
```

with an assertion about what `tables()` promises — sorted, and containing what the corpus holds:

```ts
    // By membership and order, not by an exact list: every task from 7 onward adds a table to the base
    // corpus, and an exact-array expectation here would turn "this task grew the fixture" into
    // "the driver broke". `tables()` promises the corpus's keys, sorted — that is what is asserted.
    const names = await driver.tables();
    expect(names).toEqual([...names].sort());
    for (const table of ["ACCOUNTS", "VOUCHERS", "VOUITEMS"]) expect(names).toContain(table);
```

In `packages/importer/test/reader.test.ts`, the identical replacement for

```ts
    expect(await reader.tables()).toEqual(["ACCOUNTS", "VOUCHERS", "VOUITEMS"]);
```

namely

```ts
    const names = await reader.tables();
    expect(names).toEqual([...names].sort());
    for (const table of ["ACCOUNTS", "VOUCHERS", "VOUITEMS"]) expect(names).toContain(table);
```

In `packages/importer/test/mpos-scope.test.ts`, replace the body of "profile excludes POS tables from the main
database unless asked"

```ts
    const merged = { ...loadCorpus(), tables: { ...loadCorpus().tables, ...loadCorpus("mpos").tables } };
    const reader = await createReader(new FixtureLegacyDriver(merged));
    expect((await profile(reader)).tables.map((t) => t.name)).toEqual(["ACCOUNTS", "VOUCHERS", "VOUITEMS"]);
    expect((await profile(reader, { includeMpos: true })).tables.map((t) => t.name))
      .toEqual(["ACCOUNTS", "POSENTRIES", "POSTICKETS", "VOUCHERS", "VOUITEMS"]);
```

with the same claim stated as a difference between the two runs, which no base-corpus growth can break —
`isMposTable` is already imported in this file:

```ts
    const merged = { ...loadCorpus(), tables: { ...loadCorpus().tables, ...loadCorpus("mpos").tables } };
    const reader = await createReader(new FixtureLegacyDriver(merged));
    const without = (await profile(reader)).tables.map((t) => t.name);
    const withMpos = (await profile(reader, { includeMpos: true })).tables.map((t) => t.name);
    // The claim is the filter, not the corpus: no POS table survives the default, both survive the switch,
    // and turning the switch on adds nothing else.
    expect(without.filter(isMposTable)).toEqual([]);
    expect(withMpos.filter(isMposTable)).toEqual(["POSENTRIES", "POSTICKETS"]);
    expect(withMpos.filter((name) => !isMposTable(name))).toEqual(without);
```

In `packages/importer/test/profile.test.ts`, replace the exact-array expectation

```ts
    expect(report.tables).toEqual([
      { name: "ACCOUNTS", rows: 3 },
      { name: "VOUCHERS", rows: 2, dateRange: { min: "2024-01-15", max: "2024-03-02" } },
      { name: "VOUITEMS", rows: 4 },
    ]);
```

with an assertion about the rows this test is actually about, which no later corpus growth can break:

```ts
    // Named tables only: every task from 7 onward adds one to the base corpus, and an exact-array
    // expectation here would turn "this task grew the fixture" into "the profiler broke".
    const byName = new Map(report.tables.map((t) => [t.name, t]));
    expect(byName.get("ACCOUNTS")).toEqual({ name: "ACCOUNTS", rows: 3 });
    expect(byName.get("VOUCHERS")).toEqual({ name: "VOUCHERS", rows: 2, dateRange: { min: "2024-01-15", max: "2024-03-02" } });
    expect(byName.get("VOUITEMS")).toEqual({ name: "VOUITEMS", rows: 4 });
    expect(report.tables.map((t) => t.name)).toEqual([...report.tables.map((t) => t.name)].sort());
```

In `packages/importer/test/scope.test.ts`, replace

```ts
    expect(report.totalRows).toBe(9);
    expect(report.tables).toEqual([
      { table: "ACCOUNTS", module: "standard", rows: 3, dateColumn: null, dateRange: null, note: null },
      { table: "VOUCHERS", module: "standard", rows: 2, dateColumn: "DATE", dateRange: { min: "2024-01-15", max: "2024-03-02" }, note: null },
      { table: "VOUITEMS", module: "standard", rows: 4, dateColumn: null, dateRange: null, note: null },
    ]);
```

with the same treatment:

```ts
    expect(report.totalRows).toBeGreaterThanOrEqual(9);
    const byTable = new Map(report.tables.map((t) => [t.table, t]));
    expect(byTable.get("ACCOUNTS")).toEqual({ table: "ACCOUNTS", module: "standard", rows: 3, dateColumn: null, dateRange: null, note: null });
    expect(byTable.get("VOUCHERS")).toEqual({ table: "VOUCHERS", module: "standard", rows: 2, dateColumn: "DATE", dateRange: { min: "2024-01-15", max: "2024-03-02" }, note: null });
    expect(byTable.get("VOUITEMS")).toEqual({ table: "VOUITEMS", module: "standard", rows: 4, dateColumn: null, dateRange: null, note: null });
    expect(report.tables.map((t) => t.table)).toEqual([...report.tables.map((t) => t.table)].sort());
```

and in the same file replace the exact `missingTables` length

```ts
    // 460 shipped minus the three the corpus holds.
    expect(report.missingTables).toHaveLength(457);
```

with the identity that holds at every corpus size — `missingTables` is the shipped map minus the tables that
are present *and* in the map, and `unexpectedTables` is exactly the present-but-not-in-the-map remainder:

```ts
    // The shipped map minus the tables present and in it. Holds at every corpus size, and still fails if
    // `scope` double-counts or drops a table.
    expect(report.missingTables).toHaveLength(
      ALL_LEGACY_TABLES.size - report.tables.length + report.unexpectedTables.length,
    );
```

with `import { ALL_LEGACY_TABLES } from "../src/legacy/modules";` added to `scope.test.ts`'s imports.
`expect(report.unexpectedTables).toEqual([])` and `expect(report.missingTables).toContain("PAYROLLS")` stay
exactly as they are — every table any task adds to the base corpus (`ACCTOTALS`, `ACCOBJECTS`, `JOBS`,
`MATOBJECTS`, `EMPLOYEES`, `REPORTS`) is in `LEGACY_MODULES`, so nothing becomes unexpected, and no task adds
`PAYROLLS`. Task 11 makes two further one-line edits to these files (`ACCOUNTS` 3 → 5 rows in both by-name
lookups, and `modulesInUse.salaries` `false` → `true`) when it puts rows in `EMPLOYEES` and two more in
`ACCOUNTS`; nothing else in either file moves again.

- [ ] **Step 2: Write the failing test**

`packages/importer/test/aggregate-drift.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AGGREGATE_RULES } from "../src/legacy/aggregates";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile, RECONCILIATION_KINDS } from "../src/reconcile";
import { loadCorpus } from "./support/corpus";

const reader = () => createReader(new FixtureLegacyDriver(loadCorpus()));

describe("AGGREGATE_RULES — every recomputed figure carries its own derivation (spec:2295)", () => {
  it("labels each rule verified, hypothesis or not_derivable, and never silently guesses", () => {
    for (const rule of AGGREGATE_RULES) {
      expect(rule.derivation.length).toBeGreaterThan(20);
      expect(rule.legacyDefects.length).toBeGreaterThan(0);
      if (rule.confidence === "not_derivable") expect(rule.sourceTable).toBeNull();
      else expect(rule.sourceTable).not.toBeNull();
    }
    // The columns whose routing lives in the 318 triggers and the fifteen unexamined DLLs (spec:71).
    expect(AGGREGATE_RULES.filter((r) => r.confidence === "not_derivable").map((r) => r.id)).toEqual([
      "ACCTOTALS.ADMINDEBIT", "ACCTOTALS.ADMINCREDIT", "ACCOBJECTS.OPENDEBIT", "ACCOBJECTS.OPENCREDIT",
      "MATTOTALS.INTERNALDEBIT", "MATTOTALS.INTERNALCREDIT", "MATTOTALS.ORDERDEBIT", "MATTOTALS.ORDERCREDIT",
      "MATTOTALS.TRANSFERREDDEBIT", "MATTOTALS.TRANSFERREDCREDIT",
      "MATCOSTS.COST", "MATCOSTS.BUY", "MATSTATUS.LASTPRICE",
    ]);
  });
});

describe("reconcile('aggregate_drift') — §5.1 #1, do not trust stored aggregates", () => {
  it("reports a stored figure that differs from the recomputed one, with the difference signed", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.kind).toBe("aggregate_drift");
    expect(report.rows).toContainEqual({
      rule: "ACCTOTALS.DEBIT", key: "10", stored: "300.0000", recomputed: "350.0000", difference: "-50.0000",
      status: "drift", confidence: "hypothesis",
      derivation: "sum(VOUITEMS.DEBIT) grouped by ACCOUNT, compared with ACCTOTALS.DEBIT",
    });
  });

  it("reports a source key with no stored row at all, carrying the figure that was never accumulated", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    // VOUITEMS holds two lines on account 11 within SITE 1 — DEBIT 0.0000 and 250.0000 — and ACCOBJECTS has
    // no (1, 11) row for them at all: the decrement that never fired, not a figure that drifted.
    expect(report.rows).toContainEqual(expect.objectContaining({
      rule: "ACCOBJECTS.DEBIT", key: "1|11", stored: null, recomputed: "250.0000", status: "missing_stored_row",
    }));
    expect(report.rows).toContainEqual(expect.objectContaining({
      rule: "ACCOBJECTS.CREDIT", key: "1|11", stored: null, recomputed: "100.0000", status: "missing_stored_row",
    }));
  });

  it("emits one row per not_derivable rule saying exactly what the owner must confirm", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.rows).toContainEqual(expect.objectContaining({
      rule: "ACCTOTALS.ADMINDEBIT", status: "not_derivable", stored: null, recomputed: null,
    }));
  });

  it("marks a rule whose source table or column is absent as unavailable rather than passing", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.rows).toContainEqual(expect.objectContaining({
      rule: "MATTOTALS.DEBIT", status: "source_absent",
    }));
  });

  it("summarises in strings, because the summary is read by a person", async () => {
    const report = await reconcile(await reader(), "aggregate_drift");
    expect(report.summary).toEqual({
      rules: "23", compared: "6", drifting: "1", missingStoredRows: "2",
      notDerivable: "13", sourceAbsent: "6",
      note: "Recomputed figures are labelled hypothesis until the live database confirms the routing; the 13 not_derivable columns need the owner (§5.1 #1).",
    });
    expect(report.rows).toHaveLength(22);
  });

  it("knows exactly six kinds — the closed union of contracts §4.13.1", () => {
    expect([...RECONCILIATION_KINDS]).toEqual([
      "aggregate_drift", "unbalanced_vouchers", "orphans", "null_poison", "duplicate_aggregates", "employee_mapping",
    ]);
  });
});
```

**Where the six counters come from** — every one is traced against the committed corpus, not read off a
failure diff, and the assertion is exact so that a corpus change is visible in review. `AGGREGATE_RULES` (Step
4) has **23** members: twelve written out, six from the `MATTOTALS` spread, five after it. **13** of those are
`not_derivable` (the ids listed in the first test) and are reported without touching the source. Of the
remaining ten, **six** are `source_absent` against this corpus — `ACCCURTOTALS.DEBIT`/`.CREDIT` need a `CUR`
column `VOUITEMS` does not declare, and `MATTOTALS.DEBIT`/`.CREDIT`, `MATOBJECTS.QNT`, `MATQUANTITY.QNT` all
need `BILLITEMS`, which the base corpus does not hold. The four that run are `ACCTOTALS.DEBIT`/`.CREDIT` over
`ACCTOTALS`' two rows and `ACCOBJECTS.DEBIT`/`.CREDIT` over `ACCOBJECTS`' one, so `compared` is
`2 + 2 + 1 + 1 = 6`. Exactly one comparison differs — `ACCTOTALS.DEBIT` on account 10, stored `300.0000`
against a recomputed `350.0000` — so `drifting` is **1**; `ACCTOTALS.CREDIT` agrees on both rows, and
`ACCOBJECTS`' single `(1, 10)` row agrees on both columns. Two source keys have no stored row at all
(`ACCOBJECTS.DEBIT` and `ACCOBJECTS.CREDIT` at `1|11`), so `missingStoredRows` is **2**. Total rows:
`13 + 6 + 1 + 2 = 22`. **Task 10 Step 1 nulls `ACCTOTALS` account 11's `CREDIT`**, which adds one drift and
makes it `drifting: "2"` and 23 rows; that step carries the exact one-line edit. Nothing else in this plan
moves these numbers — `JOBS` (T9), `MATOBJECTS` (T10), `EMPLOYEES` (T11) and `REPORTS` (T12) add no column any
rule reads, and T11's two extra `ACCOUNTS` rows carry no figure column.

- [ ] **Step 3: Run it and see it fail**

Run: `bun run --cwd packages/importer test aggregate`
Expected: FAIL — `Cannot find module '../src/legacy/aggregates'`.

- [ ] **Step 4: Write `packages/importer/src/legacy/aggregates.ts`**

```ts
export type AggregateConfidence = "verified" | "hypothesis" | "not_derivable";

export interface AggregateRule {
  readonly id: string;
  readonly storedTable: string;
  readonly storedColumn: string;
  readonly storedKey: readonly string[];
  /** `null` when the routing that produces this column is not derivable from anything we can read. */
  readonly sourceTable: string | null;
  readonly sourceColumn: string | null;
  readonly sourceKey: readonly string[];
  readonly confidence: AggregateConfidence;
  readonly derivation: string;
  readonly legacyDefects: readonly string[];
}

/**
 * §5.1 #1: "Do not trust stored aggregates. AccTotals, AccObjects, AccCurTotals, MatTotals, MatObjects,
 * MatQuantity, MatCosts, MatStatus are all known to drift (LEGACY-001 → 006, 049, 050). Recompute everything from
 * VouItems/BillItems and reconcile; where the recomputed figure differs from the stored one, report the
 * difference to the customer rather than silently picking one." (spec:2331)
 *
 * The dossier gives these tables' **columns** but not which document-type flags route a line into `Admin*`,
 * `Internal*`, `Order*` or `Transferred*` — that logic lives in the 318 triggers and the fifteen compiled
 * plug-in DLLs, which spec:71 records as **0% examined**. This plan does not invent it. Every rule carries its
 * own `derivation` sentence and a `confidence`; the report prints both on every line; and the `not_derivable`
 * rows are the explicit list the owner is asked to confirm. That is what "the difference on every recomputed
 * figure is explained" (spec:2295) means in practice — an unexplained figure is named as unexplained.
 */
export const AGGREGATE_RULES: readonly AggregateRule[] = [
  { id: "ACCTOTALS.DEBIT", storedTable: "ACCTOTALS", storedColumn: "DEBIT", storedKey: ["ACCOUNT"],
    sourceTable: "VOUITEMS", sourceColumn: "DEBIT", sourceKey: ["ACCOUNT"], confidence: "hypothesis",
    derivation: "sum(VOUITEMS.DEBIT) grouped by ACCOUNT, compared with ACCTOTALS.DEBIT",
    legacyDefects: ["LEGACY-001", "LEGACY-002", "LEGACY-011"] },
  { id: "ACCTOTALS.CREDIT", storedTable: "ACCTOTALS", storedColumn: "CREDIT", storedKey: ["ACCOUNT"],
    sourceTable: "VOUITEMS", sourceColumn: "CREDIT", sourceKey: ["ACCOUNT"], confidence: "hypothesis",
    derivation: "sum(VOUITEMS.CREDIT) grouped by ACCOUNT, compared with ACCTOTALS.CREDIT",
    legacyDefects: ["LEGACY-001", "LEGACY-002", "LEGACY-011"] },
  { id: "ACCTOTALS.ADMINDEBIT", storedTable: "ACCTOTALS", storedColumn: "ADMINDEBIT", storedKey: ["ACCOUNT"],
    sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
    derivation: "which document types route a line into ADMINDEBIT is encoded in the Muniments flags and the 318 triggers; spec:71 records the plug-in DLLs as 0% examined. The owner or a live trigger read must supply the rule.",
    legacyDefects: ["LEGACY-002"] },
  { id: "ACCTOTALS.ADMINCREDIT", storedTable: "ACCTOTALS", storedColumn: "ADMINCREDIT", storedKey: ["ACCOUNT"],
    sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
    derivation: "as ACCTOTALS.ADMINDEBIT, on the credit side.", legacyDefects: ["LEGACY-002"] },
  { id: "ACCOBJECTS.DEBIT", storedTable: "ACCOBJECTS", storedColumn: "DEBIT", storedKey: ["SITE", "ACCOUNT"],
    sourceTable: "VOUITEMS", sourceColumn: "DEBIT", sourceKey: ["SITE", "ACCOUNT"], confidence: "hypothesis",
    derivation: "sum(VOUITEMS.DEBIT) grouped by (SITE, ACCOUNT), compared with ACCOBJECTS.DEBIT — the trigger the dossier names is OnVouItemsAIUD_Objects.",
    legacyDefects: ["LEGACY-001", "LEGACY-049", "LEGACY-050"] },
  { id: "ACCOBJECTS.CREDIT", storedTable: "ACCOBJECTS", storedColumn: "CREDIT", storedKey: ["SITE", "ACCOUNT"],
    sourceTable: "VOUITEMS", sourceColumn: "CREDIT", sourceKey: ["SITE", "ACCOUNT"], confidence: "hypothesis",
    derivation: "sum(VOUITEMS.CREDIT) grouped by (SITE, ACCOUNT), compared with ACCOBJECTS.CREDIT.",
    legacyDefects: ["LEGACY-001", "LEGACY-049", "LEGACY-050"] },
  { id: "ACCOBJECTS.OPENDEBIT", storedTable: "ACCOBJECTS", storedColumn: "OPENDEBIT", storedKey: ["SITE", "ACCOUNT"],
    sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
    derivation: "opening balances are carried forward by a year-end procedure, not accumulated from VouItems; there is no movement history to rebuild them from. The owner supplies the opening position, and 9B posts it as an OPENING_BALANCE document.",
    legacyDefects: ["LEGACY-022"] },
  { id: "ACCOBJECTS.OPENCREDIT", storedTable: "ACCOBJECTS", storedColumn: "OPENCREDIT", storedKey: ["SITE", "ACCOUNT"],
    sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
    derivation: "as ACCOBJECTS.OPENDEBIT, on the credit side.", legacyDefects: ["LEGACY-022"] },
  { id: "ACCCURTOTALS.DEBIT", storedTable: "ACCCURTOTALS", storedColumn: "DEBIT", storedKey: ["ACCOUNT", "CUR"],
    sourceTable: "VOUITEMS", sourceColumn: "DEBIT", sourceKey: ["ACCOUNT", "CUR"], confidence: "hypothesis",
    derivation: "sum(VOUITEMS.DEBIT) grouped by (ACCOUNT, CUR), compared with ACCCURTOTALS.DEBIT. LEGACY-001 is exactly this table updated without the Site key, so drift here is expected, not surprising.",
    legacyDefects: ["LEGACY-001", "LEGACY-012", "LEGACY-014"] },
  { id: "ACCCURTOTALS.CREDIT", storedTable: "ACCCURTOTALS", storedColumn: "CREDIT", storedKey: ["ACCOUNT", "CUR"],
    sourceTable: "VOUITEMS", sourceColumn: "CREDIT", sourceKey: ["ACCOUNT", "CUR"], confidence: "hypothesis",
    derivation: "sum(VOUITEMS.CREDIT) grouped by (ACCOUNT, CUR), compared with ACCCURTOTALS.CREDIT.",
    legacyDefects: ["LEGACY-001", "LEGACY-012", "LEGACY-014"] },
  { id: "MATTOTALS.DEBIT", storedTable: "MATTOTALS", storedColumn: "DEBIT", storedKey: ["MATERIAL"],
    sourceTable: "BILLITEMS", sourceColumn: "DEBIT", sourceKey: ["MATERIAL"], confidence: "hypothesis",
    derivation: "sum(BILLITEMS.DEBIT) grouped by MATERIAL, compared with MATTOTALS.DEBIT.",
    legacyDefects: ["LEGACY-004", "LEGACY-006", "LEGACY-016"] },
  { id: "MATTOTALS.CREDIT", storedTable: "MATTOTALS", storedColumn: "CREDIT", storedKey: ["MATERIAL"],
    sourceTable: "BILLITEMS", sourceColumn: "CREDIT", sourceKey: ["MATERIAL"], confidence: "hypothesis",
    derivation: "sum(BILLITEMS.CREDIT) grouped by MATERIAL, compared with MATTOTALS.CREDIT.",
    legacyDefects: ["LEGACY-004", "LEGACY-006", "LEGACY-016"] },
  ...(["INTERNALDEBIT", "INTERNALCREDIT", "ORDERDEBIT", "ORDERCREDIT", "TRANSFERREDDEBIT", "TRANSFERREDCREDIT"] as const)
    .map((column): AggregateRule => ({
      id: ["MATTOTALS", column].join("."), storedTable: "MATTOTALS", storedColumn: column, storedKey: ["MATERIAL"],
      sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
      derivation: `which document types route a BillItems line into MATTOTALS.${column} is a Muniments flag combination this project has not read; spec:71 records the plug-in DLLs as 0% examined. The owner or a live trigger read must supply the rule.`,
      legacyDefects: ["LEGACY-004", "LEGACY-018"],
    })),
  { id: "MATOBJECTS.QNT", storedTable: "MATOBJECTS", storedColumn: "QNT", storedKey: ["MATERIAL", "WAREHOUSE"],
    sourceTable: "BILLITEMS", sourceColumn: "QNT", sourceKey: ["MATERIAL", "WAREHOUSE"], confidence: "hypothesis",
    derivation: "sum(BILLITEMS.QNT) grouped by (MATERIAL, WAREHOUSE), compared with MATOBJECTS.QNT. MatObjects has no key columns at all (LEGACY-049), so a duplicate key here is a finding in its own right — see the duplicate_aggregates report.",
    legacyDefects: ["LEGACY-049", "LEGACY-050"] },
  { id: "MATQUANTITY.QNT", storedTable: "MATQUANTITY", storedColumn: "QNT", storedKey: ["MATERIAL", "WAREHOUSE", "BATCH"],
    sourceTable: "BILLITEMS", sourceColumn: "QNT", sourceKey: ["MATERIAL", "WAREHOUSE", "BATCH"], confidence: "hypothesis",
    derivation: "sum(BILLITEMS.QNT) grouped by (MATERIAL, WAREHOUSE, BATCH), compared with MATQUANTITY.QNT.",
    legacyDefects: ["LEGACY-049", "LEGACY-050"] },
  { id: "MATCOSTS.COST", storedTable: "MATCOSTS", storedColumn: "COST", storedKey: ["SITE", "MATERIAL"],
    sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
    derivation: "§5.1 #6: do not import cost figures. MatCosts has no rebuild path and multiple corruption routes (LEGACY-004, 007, 008, 009). Cost is recomputed from movement history by the 3B engine at load time and the resulting opening valuation is reconciled with the customer — it is never compared with this column.",
    legacyDefects: ["LEGACY-004", "LEGACY-007", "LEGACY-008", "LEGACY-009"] },
  { id: "MATCOSTS.BUY", storedTable: "MATCOSTS", storedColumn: "BUY", storedKey: ["SITE", "MATERIAL"],
    sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
    derivation: "as MATCOSTS.COST (§5.1 #6).", legacyDefects: ["LEGACY-004", "LEGACY-008"] },
  { id: "MATSTATUS.LASTPRICE", storedTable: "MATSTATUS", storedColumn: "LASTPRICE", storedKey: ["SITE", "MATERIAL", "MUNIMENT"],
    sourceTable: null, sourceColumn: null, sourceKey: [], confidence: "not_derivable",
    derivation: "MatStatus is an INSERT-only min/max ratchet (LEGACY-016): it records the extreme prices ever seen and is not a function of current rows, so there is nothing to recompute it from.",
    legacyDefects: ["LEGACY-016"] },
];
```

- [ ] **Step 5: Write `packages/importer/src/reconcile/probe.ts`**

```ts
import type { LegacyReader } from "../reader";

/**
 * Whether a table has every one of these columns. `LegacyReader` (§4.13.1) has no catalogue accessor, so the
 * question is asked the only way the interface allows: request one batch of exactly those columns and see
 * whether the driver refuses. A refusal is `ERR_IMPORT_SOURCE_UNREADABLE` from `quoteIdent`'s membership gate.
 *
 * This is what keeps AGGREGATE_RULES honest: the source column names in it are read from a dossier, not from
 * the customer's database, and a rule whose columns are not there is reported `source_absent` rather than
 * quietly producing zero and calling it a match.
 */
export async function hasColumns(reader: LegacyReader, table: string, columns: readonly string[]): Promise<boolean> {
  try {
    for await (const _ of reader.read(table, { columns: [...columns], batch: 1 })) break;
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Write `packages/importer/src/reconcile/aggregate-drift.ts`**

```ts
import Decimal from "decimal.js";
import { AGGREGATE_RULES, type AggregateRule } from "../legacy/aggregates";
import type { LegacyReader } from "../reader";
import type { LegacyRow } from "../legacy/types";
import { hasColumns } from "./probe";
import type { ReconciliationReport } from "./index";

/** Big enough that a million-row BillItems is a couple of hundred round trips, small enough to bound memory. */
export const READ_BATCH = 5_000;

const ZERO = "0.0000";
const key = (row: LegacyRow, columns: readonly string[]): string => columns.map((c) => String(row[c] ?? "")).join("|");
const money = (value: unknown): Decimal => new Decimal(value === null || value === undefined || value === "" ? "0" : String(value));

/**
 * §5.1 #1. For every rule: recompute the figure from the source, read the stored figure, and report the
 * difference. Nothing is repaired, nothing is chosen — LEGACY-079 is a system with 44 repair objects that silently
 * "fixed" numbers, and this report exists so the customer decides instead.
 */
export async function aggregateDrift(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let compared = 0, drifting = 0, missingStoredRows = 0, notDerivable = 0, sourceAbsent = 0;

  for (const rule of AGGREGATE_RULES) {
    if (rule.sourceTable === null || rule.sourceColumn === null) {
      notDerivable += 1;
      rows.push(base(rule, "", { status: "not_derivable", stored: null, recomputed: null, difference: null }));
      continue;
    }
    const sourceReady = await hasColumns(reader, rule.sourceTable, [...rule.sourceKey, rule.sourceColumn]);
    const storedReady = await hasColumns(reader, rule.storedTable, [...rule.storedKey, rule.storedColumn]);
    if (!sourceReady || !storedReady) {
      sourceAbsent += 1;
      rows.push(base(rule, "", {
        status: "source_absent", stored: null, recomputed: null, difference: null,
        detail: [sourceReady ? null : rule.sourceTable, storedReady ? null : rule.storedTable]
          .filter((t) => t !== null).join(", "),
      }));
      continue;
    }

    const recomputed = new Map<string, Decimal>();
    for await (const batch of reader.read<LegacyRow>(rule.sourceTable, { columns: [...rule.sourceKey, rule.sourceColumn], batch: READ_BATCH })) {
      for (const row of batch) {
        const k = key(row, rule.sourceKey);
        recomputed.set(k, (recomputed.get(k) ?? new Decimal(0)).plus(money(row[rule.sourceColumn])));
      }
    }

    const seen = new Set<string>();
    for await (const batch of reader.read<LegacyRow>(rule.storedTable, { columns: [...rule.storedKey, rule.storedColumn], batch: READ_BATCH })) {
      for (const row of batch) {
        const k = key(row, rule.storedKey);
        seen.add(k);
        compared += 1;
        const storedValue = row[rule.storedColumn];
        const stored = money(storedValue);
        const computed = recomputed.get(k) ?? new Decimal(0);
        if (!stored.equals(computed)) {
          drifting += 1;
          rows.push(base(rule, k, {
            status: "drift",
            stored: storedValue === null || storedValue === undefined ? ZERO : String(storedValue),
            recomputed: computed.toFixed(4),
            difference: stored.minus(computed).toFixed(4),
          }));
        }
      }
    }

    for (const [k, computed] of recomputed) {
      if (seen.has(k)) continue;
      missingStoredRows += 1;
      rows.push(base(rule, k, { status: "missing_stored_row", stored: null, recomputed: computed.toFixed(4), difference: null }));
    }
    // A stored key the source does not produce is already covered: it appears above as a `drift` against zero.
  }

  return {
    kind: "aggregate_drift",
    rows,
    summary: {
      rules: String(AGGREGATE_RULES.length),
      compared: String(compared),
      drifting: String(drifting),
      missingStoredRows: String(missingStoredRows),
      notDerivable: String(notDerivable),
      sourceAbsent: String(sourceAbsent),
      note: [
        "Recomputed figures are labelled hypothesis until the live database confirms the routing; the",
        String(notDerivable), "not_derivable columns need the owner (§5.1 #1).",
      ].join(" "),
    },
  };
}

function base(rule: AggregateRule, k: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { rule: rule.id, key: k, confidence: rule.confidence, derivation: rule.derivation, ...extra };
}
```

**Note the one asymmetry, and that it is deliberate.** A key present in the stored table but absent from the
source is reported as `drift` with `recomputed: "0.0000"` — the orphan aggregate row LEGACY-050 describes. A key
present in the source but absent from the stored table is `missing_stored_row` — the decrement that never
fired. They are different defects and the report keeps them apart.

- [ ] **Step 7: Write `packages/importer/src/reconcile/index.ts`**

```ts
import type { LegacyReader } from "../reader";
import { aggregateDrift } from "./aggregate-drift";

/** Contracts §4.13.1, verbatim — mutable members and the closed six-member `kind` union included. */
export interface ReconciliationReport {
  kind: "aggregate_drift" | "unbalanced_vouchers" | "orphans" | "null_poison" | "duplicate_aggregates" | "employee_mapping";
  rows: Record<string, unknown>[];
  summary: Record<string, string>;
}

export const RECONCILIATION_KINDS: readonly ReconciliationReport["kind"][] = [
  "aggregate_drift", "unbalanced_vouchers", "orphans", "null_poison", "duplicate_aggregates", "employee_mapping",
];

/** Tasks 8–11 each add one branch. The dispatcher is exhaustive: TypeScript rejects a missing kind. */
export async function reconcile(reader: LegacyReader, kind: ReconciliationReport["kind"]): Promise<ReconciliationReport> {
  switch (kind) {
    case "aggregate_drift": return aggregateDrift(reader);
    default: throw new Error(`ERR_IMPORT_SOURCE_UNREADABLE: reconciliation kind ${kind} is not implemented yet`);
  }
}
```

The `default` branch disappears entirely by Task 11, when all six cases are present and the switch is
exhaustive over the union.

- [ ] **Step 8: Add the `reconcile` command to the CLI and the exports to the barrel**

In `packages/importer/src/cli.ts`, a branch beside `profile`:

```ts
    if (args.command === "reconcile") {
      const reader = await createReader(driver, args.flags["firebird-version"]);
      const requested = args.flags.kind ?? "all";
      const kinds = requested === "all" ? RECONCILIATION_KINDS : [requested as (typeof RECONCILIATION_KINDS)[number]];
      const writer = new ReportWriter(out, { source: driver.source, engineVersion: reader.firebirdVersion });
      for (const kind of kinds) {
        const report = await reconcile(reader, kind);
        writer.json([kind, "json"].join("."), report, report.rows.length);
        writer.csv([kind, "csv"].join("."), report.rows as Record<string, unknown>[]);
        console.log([kind, ":", String(report.rows.length), "findings —",
          Object.entries(report.summary).map(([k, v]) => [k, v].join("=")).join(" ")].join(" "));
      }
      const index = writer.finish();
      console.log(["wrote:", index.artefacts.map((a) => a.name).join(", "), "->", out].join(" "));
      return 0;
    }
```

In `packages/importer/src/index.ts`:

```ts
export { reconcile, RECONCILIATION_KINDS, type ReconciliationReport } from "./reconcile";
export { AGGREGATE_RULES, type AggregateRule, type AggregateConfidence } from "./legacy/aggregates";
```

- [ ] **Step 9: Run everything and commit**

Run: `bun run --cwd packages/importer test`
Expected: PASS — the whole package, `fixture-driver`, `scope`, `reader`, `profile` and `mpos-scope` included,
because Step 1 applied correction C1 before the corpus grew. If any of those five suites is red on an exact
table list, C1 was not applied in full; go back to Step 1.

Run: `bun run legacy reconcile --kind aggregate_drift --fixture base --out artefacts/legacy/dev`
Expected, on stdout:

```
aggregate_drift : 22 findings — rules=23 compared=6 drifting=1 missingStoredRows=2 notDerivable=13 sourceAbsent=6 note=Recomputed figures are labelled hypothesis until the live database confirms the routing; the 13 not_derivable columns need the owner (§5.1 #1).
wrote: aggregate_drift.json, aggregate_drift.csv, index.json -> artefacts/legacy/dev
```

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```
feat(importer): recompute every legacy aggregate and report the drift [9A T7]

§5.1 #1 — do not trust stored aggregates. AGGREGATE_RULES is declarative: each row
names its stored column, its source, its derivation in English and a confidence, and
the report prints all three on every line. The routing the dossier does not give —
Admin*, Internal*, Order*, Transferred*, and every MatCosts/MatStatus column — is
reported `not_derivable` by name rather than guessed, and a rule whose source columns
are absent in this database is `source_absent`, never a silent zero-versus-zero match.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 8: Unbalanced vouchers, quantified — and the suspense-account decision input (§5.1 #2)

**Files:**
- Create: `packages/importer/src/reconcile/unbalanced-vouchers.ts`
- Modify: `packages/importer/src/reconcile/index.ts` (one case)
- Test: `packages/importer/test/unbalanced-vouchers.test.ts`

**Interfaces:**
- Consumes: `LegacyReader` (T4), `ReconciliationReport` (T7), `hasColumns`, `READ_BATCH` (T7).
- Produces: `export async function unbalancedVouchers(reader: LegacyReader): Promise<ReconciliationReport>;`, `export const SUSPENSE_QUESTION: string;`

> **This is the input to OD-25, not the decision.** OD-25 ("suspense-account treatment for unbalanced vouchers;
> the cut-over date", spec:2334) is **9B's** owner gate and is isolated in 9B's cut-over task. 9A's job is to
> put the number in front of the owner: how many vouchers, by how much, over what date range, on which
> accounts. The report carries `SUSPENSE_QUESTION` verbatim and no recommendation.

- [ ] **Step 1: Write the failing test**

`packages/importer/test/unbalanced-vouchers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { loadCorpus } from "./support/corpus";

describe("reconcile('unbalanced_vouchers') — §5.1 #2, LEGACY-003 'nothing enforces debits = credits'", () => {
  it("names each unbalanced voucher, signs the imbalance, and dates it from its header", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "unbalanced_vouchers");
    expect(report.kind).toBe("unbalanced_vouchers");
    // Voucher (1,1) balances: 100 debit, 100 credit. Voucher (1,2) is 500 debit, 0 credit.
    expect(report.rows).toEqual([
      { voucher: "1|2", date: "2024-03-02", lines: 2, debit: "500.0000", credit: "0.0000",
        imbalance: "500.0000", accounts: "10,11" },
    ]);
  });

  it("quantifies the whole population, because the owner decides on the total and not on one row", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "unbalanced_vouchers");
    expect(report.summary.vouchers).toBe("2");
    expect(report.summary.unbalanced).toBe("1");
    expect(report.summary.absoluteImbalance).toBe("500.0000");
    expect(report.summary.netImbalance).toBe("500.0000");
    expect(report.summary.largest).toBe("1|2 500.0000");
    expect(report.summary.dateRange).toBe("2024-03-02..2024-03-02");
    expect(report.summary.question).toContain("suspense account");
  });

  it("reports the source as absent rather than reporting zero unbalanced vouchers", async () => {
    const corpus = loadCorpus();
    const without = { ...corpus, tables: Object.fromEntries(Object.entries(corpus.tables).filter(([t]) => t !== "VOUITEMS")) };
    const report = await reconcile(await createReader(new FixtureLegacyDriver(without)), "unbalanced_vouchers");
    expect(report.summary.status).toBe("source_absent");
    expect(report.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test unbalanced`
Expected: FAIL — `reconciliation kind unbalanced_vouchers is not implemented yet`.

- [ ] **Step 3: Write `packages/importer/src/reconcile/unbalanced-vouchers.ts`**

```ts
import Decimal from "decimal.js";
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import { hasColumns } from "./probe";
import type { ReconciliationReport } from "./index";

export const SUSPENSE_QUESTION =
  "Expect unbalanced vouchers. Nothing prevented them (LEGACY-003). Detect them, quantify them, and agree a " +
  "treatment (suspense account) with the customer *before* migrating. (spec:2332, §5.1 #2; the decision is " +
  "OD-25 and belongs to 9B's cut-over task — this report is its input.)";

interface Bucket { debit: Decimal; credit: Decimal; lines: number; accounts: Set<string> }

const amount = (value: unknown): Decimal => new Decimal(value === null || value === undefined || value === "" ? "0" : String(value));

/**
 * §5.1 #2. One pass over VouItems to bucket by voucher, one over Vouchers to date them. The imbalance is
 * `debit − credit` and is signed, so a report that is read as a total tells the owner which side the suspense
 * account lands on. Nothing here proposes a treatment: that is OD-25, and hazard 7 forbids this plan deciding it.
 */
export async function unbalancedVouchers(reader: LegacyReader): Promise<ReconciliationReport> {
  const ready = await hasColumns(reader, "VOUITEMS", ["SITE", "ID", "ACCOUNT", "DEBIT", "CREDIT"]);
  if (!ready) {
    return { kind: "unbalanced_vouchers", rows: [], summary: { status: "source_absent", question: SUSPENSE_QUESTION,
      note: "VOUITEMS does not declare SITE, ID, ACCOUNT, DEBIT and CREDIT in this database; nothing was compared." } };
  }

  const buckets = new Map<string, Bucket>();
  for await (const batch of reader.read<LegacyRow>("VOUITEMS", { columns: ["SITE", "ID", "ACCOUNT", "DEBIT", "CREDIT"], batch: READ_BATCH })) {
    for (const row of batch) {
      const k = [String(row.SITE ?? ""), String(row.ID ?? "")].join("|");
      const bucket = buckets.get(k) ?? { debit: new Decimal(0), credit: new Decimal(0), lines: 0, accounts: new Set<string>() };
      bucket.debit = bucket.debit.plus(amount(row.DEBIT));
      bucket.credit = bucket.credit.plus(amount(row.CREDIT));
      bucket.lines += 1;
      if (row.ACCOUNT !== null && row.ACCOUNT !== undefined) bucket.accounts.add(String(row.ACCOUNT));
      buckets.set(k, bucket);
    }
  }

  const dates = new Map<string, string>();
  if (await hasColumns(reader, "VOUCHERS", ["SITE", "ID", "DATE"])) {
    for await (const batch of reader.read<LegacyRow>("VOUCHERS", { columns: ["SITE", "ID", "DATE"], batch: READ_BATCH })) {
      for (const row of batch) dates.set([String(row.SITE ?? ""), String(row.ID ?? "")].join("|"), String(row.DATE ?? ""));
    }
  }

  const rows: Record<string, unknown>[] = [];
  let absolute = new Decimal(0);
  let net = new Decimal(0);
  let largestKey = "";
  let largest = new Decimal(0);
  const dated: string[] = [];

  for (const [voucher, bucket] of [...buckets].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const imbalance = bucket.debit.minus(bucket.credit);
    if (imbalance.isZero()) continue;
    absolute = absolute.plus(imbalance.abs());
    net = net.plus(imbalance);
    if (imbalance.abs().greaterThan(largest.abs())) { largest = imbalance; largestKey = voucher; }
    const date = dates.get(voucher) ?? "";
    if (date !== "") dated.push(date);
    rows.push({
      voucher, date, lines: bucket.lines,
      debit: bucket.debit.toFixed(4), credit: bucket.credit.toFixed(4),
      imbalance: imbalance.toFixed(4), accounts: [...bucket.accounts].sort((a, b) => a.localeCompare(b, "en")).join(","),
    });
  }

  dated.sort();
  return {
    kind: "unbalanced_vouchers",
    rows,
    summary: {
      status: "compared",
      vouchers: String(buckets.size),
      unbalanced: String(rows.length),
      absoluteImbalance: absolute.toFixed(4),
      netImbalance: net.toFixed(4),
      largest: rows.length === 0 ? "none" : [largestKey, largest.toFixed(4)].join(" "),
      dateRange: dated.length === 0 ? "unknown" : [dated[0], dated[dated.length - 1]].join(".."),
      question: SUSPENSE_QUESTION,
    },
  };
}
```

- [ ] **Step 4: Add the case to the dispatcher**

In `packages/importer/src/reconcile/index.ts`, above the `default`:

```ts
    case "unbalanced_vouchers": return unbalancedVouchers(reader);
```

with `import { unbalancedVouchers } from "./unbalanced-vouchers";`.

- [ ] **Step 5: Run, verify, commit**

Run: `bun run --cwd packages/importer test` → PASS, the whole package (this task adds no corpus row, so
nothing else moves).
Run: `bun run legacy reconcile --kind unbalanced_vouchers --fixture base --out artefacts/legacy/dev` →
`unbalanced_vouchers : 1 findings — status=compared vouchers=2 unbalanced=1 …`.

```
feat(importer): detect and quantify unbalanced vouchers [9A T8]

§5.1 #2 / LEGACY-003. Signed imbalance per voucher with its date, its line count and the
accounts it touches; the summary carries the population totals, the largest single
imbalance and the date range, because the owner decides on the total. The suspense
treatment itself is OD-25 and belongs to 9B — this report states the question verbatim
and proposes nothing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 9: The orphan report (§5.1 #3)

**Files:**
- Create: `packages/importer/src/reconcile/orphans.ts`
- Modify: `packages/importer/src/reconcile/index.ts` (one case), `packages/importer/test/corpus/base/*` (add `JOBS`)
- Test: `packages/importer/test/orphans.test.ts`

**Interfaces:**
- Consumes: `LegacyReader` (T4), `hasColumns`, `READ_BATCH` (T7).
- Produces:
  ```ts
  export interface OrphanRule { readonly id: string; readonly childTable: string; readonly childColumns: readonly string[]; readonly parentTable: string; readonly parentColumns: readonly string[]; readonly ignoreValues: readonly string[]; readonly note: string; readonly legacyDefects: readonly string[] }
  export const ORPHAN_RULES: readonly OrphanRule[];
  export async function orphans(reader: LegacyReader): Promise<ReconciliationReport>;
  ```

- [ ] **Step 1: Extend the corpus with `JOBS`**

Add to `catalog.json`:

```json
    "JOBS": {
      "keyColumns": ["ID"],
      "columns": [
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "NAME", "kind": "text", "scale": 0, "nullable": true }
      ]
    }
```

`packages/importer/test/corpus/base/JOBS.json`:

```json
[{ "ID": "1", "NAME": "Main contract" }]
```

`VOUITEMS` row `(1,2,1)` already carries `JOB = "99"`, which no `JOBS` row resolves — LEGACY-073's 82%
unconstrained `Job` reference, in one line.

- [ ] **Step 2: Write the failing test**

`packages/importer/test/orphans.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { ORPHAN_RULES } from "../src/reconcile/orphans";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { loadCorpus } from "./support/corpus";

describe("reconcile('orphans') — §5.1 #3, 'report orphans; do not silently null them'", () => {
  it("names each dangling reference with the child row that holds it", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "orphans");
    expect(report.rows).toContainEqual({
      rule: "VOUITEMS.JOB", childTable: "VOUITEMS", value: "99", occurrences: 1,
      parentTable: "JOBS", status: "orphan",
      note: "Job is 82% unconstrained across the shipped schema (LEGACY-073); the shipped fixes/fix-Jobs.sql exists because orphans occur.",
    });
  });

  it("treats 0 and the empty string as 'not set', never as a dangling key", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "orphans");
    expect(report.rows.filter((r) => r.rule === "VOUITEMS.JOB" && r.value === "0")).toEqual([]);
  });

  it("skips a rule whose parent or child table is not in this database, and says which", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "orphans");
    expect(report.rows).toContainEqual(expect.objectContaining({ rule: "BILLITEMS.MATERIAL", status: "source_absent" }));
    expect(report.summary.rules).toBe(String(ORPHAN_RULES.length));
    expect(report.summary.orphanedValues).toBe("1");
    expect(report.summary.orphanedRows).toBe("1");
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `bun run --cwd packages/importer test orphans` → FAIL, `kind orphans is not implemented yet`.

- [ ] **Step 4: Write `packages/importer/src/reconcile/orphans.ts`**

```ts
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import { hasColumns } from "./probe";
import type { ReconciliationReport } from "./index";

export interface OrphanRule {
  readonly id: string;
  readonly childTable: string; readonly childColumns: readonly string[];
  readonly parentTable: string; readonly parentColumns: readonly string[];
  /** Sentinels the legacy schema uses for "not set". A `0` Job is not an orphan; it is an absent reference. */
  readonly ignoreValues: readonly string[];
  readonly note: string;
  readonly legacyDefects: readonly string[];
}

const UNSET = ["", "0"] as const;

/**
 * §5.1 #3: "Expect orphaned references. `Job` 82% and `CostCentre` 81% unconstrained (LEGACY-073); the shipped
 * `fixes/fix-Jobs.sql` and `fix-finals.sql` prove orphans occur. **Report orphans; do not silently null them.**"
 * (spec:2333) Every rule is a relationship the dossier names; a rule whose tables are not in this database is
 * reported `source_absent` rather than passing.
 */
export const ORPHAN_RULES: readonly OrphanRule[] = [
  { id: "VOUITEMS.JOB", childTable: "VOUITEMS", childColumns: ["JOB"], parentTable: "JOBS", parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    note: "Job is 82% unconstrained across the shipped schema (LEGACY-073); the shipped fixes/fix-Jobs.sql exists because orphans occur.",
    legacyDefects: ["LEGACY-073"] },
  { id: "VOUITEMS.COSTCENTRE", childTable: "VOUITEMS", childColumns: ["COSTCENTRE"], parentTable: "COSTCENTRES", parentColumns: ["ID"],
    ignoreValues: [...UNSET], note: "CostCentre is 81% unconstrained (LEGACY-073).", legacyDefects: ["LEGACY-073"] },
  { id: "VOUITEMS.ACCOUNT", childTable: "VOUITEMS", childColumns: ["ACCOUNT"], parentTable: "ACCOUNTS", parentColumns: ["ID"],
    ignoreValues: [...UNSET],
    note: "Accounts are deletable with postings against them (LEGACY-021), so a line can outlive its account.",
    legacyDefects: ["LEGACY-021", "LEGACY-073"] },
  { id: "VOUITEMS.VOUCHER", childTable: "VOUITEMS", childColumns: ["SITE", "ID"], parentTable: "VOUCHERS", parentColumns: ["SITE", "ID"],
    ignoreValues: [], note: "A line whose header no longer exists is invisible to every report that starts from Vouchers.",
    legacyDefects: ["LEGACY-073", "LEGACY-074"] },
  { id: "BILLITEMS.MATERIAL", childTable: "BILLITEMS", childColumns: ["MATERIAL"], parentTable: "MATERIALS", parentColumns: ["ID"],
    ignoreValues: [...UNSET], note: "A movement whose item no longer exists cannot be recosted by the 3B engine.",
    legacyDefects: ["LEGACY-073"] },
  { id: "BILLITEMS.WAREHOUSE", childTable: "BILLITEMS", childColumns: ["WAREHOUSE"], parentTable: "WAREHOUSES", parentColumns: ["ID"],
    ignoreValues: [...UNSET], note: "A movement with no warehouse cannot be placed in the opening stock position.",
    legacyDefects: ["LEGACY-073"] },
  { id: "BILLITEMS.BATCH", childTable: "BILLITEMS", childColumns: ["BATCH"], parentTable: "BATCHES", parentColumns: ["ID"],
    ignoreValues: [...UNSET], note: "A lot reference with no lot loses the expiry position §5.1 asks 9B to import.",
    legacyDefects: ["LEGACY-073"] },
  { id: "BILLITEMS.BILL", childTable: "BILLITEMS", childColumns: ["SITE", "ID"], parentTable: "BILLS", parentColumns: ["SITE", "ID"],
    ignoreValues: [], note: "As VOUITEMS.VOUCHER, on the inventory side.", legacyDefects: ["LEGACY-073", "LEGACY-074"] },
  { id: "JOURNAL.ACCOUNT", childTable: "JOURNAL", childColumns: ["ACCOUNT"], parentTable: "ACCOUNTS", parentColumns: ["ID"],
    ignoreValues: [...UNSET], note: "Journal is the document-level movement row; an orphan here is a balance with no account.",
    legacyDefects: ["LEGACY-021", "LEGACY-073"] },
];

const key = (row: LegacyRow, columns: readonly string[]): string => columns.map((c) => String(row[c] ?? "")).join("|");

export async function orphans(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let orphanedValues = 0;
  let orphanedRows = 0;
  let skipped = 0;

  for (const rule of ORPHAN_RULES) {
    const ready = (await hasColumns(reader, rule.childTable, rule.childColumns))
      && (await hasColumns(reader, rule.parentTable, rule.parentColumns));
    if (!ready) {
      skipped += 1;
      rows.push({ rule: rule.id, childTable: rule.childTable, value: null, occurrences: 0,
        parentTable: rule.parentTable, status: "source_absent", note: rule.note });
      continue;
    }

    const parents = new Set<string>();
    for await (const batch of reader.read<LegacyRow>(rule.parentTable, { columns: [...rule.parentColumns], batch: READ_BATCH })) {
      for (const row of batch) parents.add(key(row, rule.parentColumns));
    }

    const dangling = new Map<string, number>();
    for await (const batch of reader.read<LegacyRow>(rule.childTable, { columns: [...rule.childColumns], batch: READ_BATCH })) {
      for (const row of batch) {
        const value = key(row, rule.childColumns);
        if (rule.childColumns.length === 1 && rule.ignoreValues.includes(value)) continue;
        if (parents.has(value)) continue;
        dangling.set(value, (dangling.get(value) ?? 0) + 1);
      }
    }

    for (const [value, occurrences] of [...dangling].sort(([a], [b]) => a.localeCompare(b, "en"))) {
      orphanedValues += 1;
      orphanedRows += occurrences;
      rows.push({ rule: rule.id, childTable: rule.childTable, value, occurrences, parentTable: rule.parentTable, status: "orphan", note: rule.note });
    }
  }

  return {
    kind: "orphans", rows,
    summary: {
      rules: String(ORPHAN_RULES.length), skipped: String(skipped),
      orphanedValues: String(orphanedValues), orphanedRows: String(orphanedRows),
      note: "Orphans are reported, never nulled and never resolved to a default (§5.1 #3). 9B refuses to load a row whose parent this report lists.",
    },
  };
}
```

- [ ] **Step 5: Add the case, run, commit**

`case "orphans": return orphans(reader);` in the dispatcher, with its import.

Run: `bun run --cwd packages/importer test` → PASS, the whole package. Adding `JOBS` moves `scope`'s table and
row counts and turns `profile`'s `modulesInUse.system` true, and correction C1 (Task 7 Step 1) already made
both suites insensitive to that; `system` is not asserted anywhere.

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```
feat(importer): report orphaned legacy references [9A T9]

§5.1 #3 / LEGACY-073. Nine declarative rules over the relationships the dossier names,
each counting distinct dangling values and the rows that hold them. 0 and the empty
string are "not set", not orphans. A rule whose tables are not in this database is
`source_absent`, never a pass. Nothing is nulled and nothing is defaulted.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 10: NULL-poisoned figures and duplicate aggregate rows (§5.1 #4, #5)

**Files:**
- Create: `packages/importer/src/reconcile/null-poison.ts`, `packages/importer/src/reconcile/duplicate-aggregates.ts`
- Modify: `packages/importer/src/reconcile/index.ts` (two cases)
- Test: `packages/importer/test/null-poison.test.ts`, `packages/importer/test/duplicate-aggregates.test.ts`

**Interfaces:**
- Consumes: `LegacyReader` (T4), `AGGREGATE_RULES` (T7), `hasColumns`, `READ_BATCH` (T7).
- Produces:
  ```ts
  export interface NullPoisonTarget { readonly table: string; readonly columns: readonly string[]; readonly why: string; readonly legacyDefects: readonly string[] }
  export const NULL_POISON_TARGETS: readonly NullPoisonTarget[];
  export async function nullPoison(reader: LegacyReader): Promise<ReconciliationReport>;
  export interface DuplicateTarget { readonly table: string; readonly naturalKey: readonly string[]; readonly why: string; readonly legacyDefects: readonly string[] }
  export const DUPLICATE_TARGETS: readonly DuplicateTarget[];
  export async function duplicateAggregates(reader: LegacyReader): Promise<ReconciliationReport>;
  ```

- [ ] **Step 1: Poison the corpus, deliberately**

Change one row of `packages/importer/test/corpus/base/ACCTOTALS.json` so account `11`'s `CREDIT` is `null`
rather than `"100.0000"` — the shape LEGACY-011 produces, which "will appear as blank or zero, not as an error".
Add a second `MATOBJECTS` row with the same natural key as the first (LEGACY-049's duplicate), by adding to
`catalog.json`:

```json
    "MATOBJECTS": {
      "keyColumns": [],
      "columns": [
        { "name": "MATERIAL", "kind": "integer", "scale": 0, "nullable": true },
        { "name": "WAREHOUSE", "kind": "integer", "scale": 0, "nullable": true },
        { "name": "QNT", "kind": "decimal", "scale": 6, "nullable": true }
      ]
    }
```

and `packages/importer/test/corpus/base/MATOBJECTS.json`:

```json
[
  { "MATERIAL": "5", "WAREHOUSE": "1", "QNT": "10.000000" },
  { "MATERIAL": "5", "WAREHOUSE": "1", "QNT": "10.000000" },
  { "MATERIAL": "6", "WAREHOUSE": "1", "QNT": null }
]
```

`keyColumns: []` is the truth: "`MatObjects` and `MatQuantity` have **no key columns**" (LEGACY-049) — which is
precisely why the duplicate could be created.

**One edit to Task 7's test follows from the `ACCTOTALS` change, and it is exactly one.** With account 11's
`CREDIT` null, rule `ACCTOTALS.CREDIT` reads `0` where `VOUITEMS` recomputes `100.0000`, so a second row drifts
— which is the whole point of the poison, and Task 7's drift report is where it surfaces. In
`packages/importer/test/aggregate-drift.test.ts`, in the `summary` assertion, change

```ts
      rules: "23", compared: "6", drifting: "1", missingStoredRows: "2",
```

to

```ts
      rules: "23", compared: "6", drifting: "2", missingStoredRows: "2",
```

and change `expect(report.rows).toHaveLength(22);` in the same test to `toHaveLength(23);`. Nothing else in
that file moves: `compared` still counts the same six stored rows, and a null stored figure is reported as
`stored: "0.0000"` by `aggregate-drift.ts`'s own `ZERO` fallback rather than dropped. Adding `MATOBJECTS`
changes no counter either — `MATOBJECTS.QNT`'s rule needs `BILLITEMS`, which the corpus still does not hold,
so it stays `source_absent`.

- [ ] **Step 2: Write both failing tests**

`packages/importer/test/null-poison.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { loadCorpus } from "./support/corpus";

describe("reconcile('null_poison') — §5.1 #4, LEGACY-007 and LEGACY-011", () => {
  it("counts NULLs in every figure column that a report would silently render as zero", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "null_poison");
    expect(report.rows).toContainEqual(expect.objectContaining({
      table: "ACCTOTALS", column: "CREDIT", nulls: 1, rows: 2, status: "poisoned",
    }));
    expect(report.rows).toContainEqual(expect.objectContaining({
      table: "MATOBJECTS", column: "QNT", nulls: 1, rows: 3, status: "poisoned",
    }));
    // Task 7's ACCOBJECTS row carries null opening figures, which is the same defect on the opening side —
    // and the reason `poisonedColumns` is four and not two.
    expect(report.rows).toContainEqual(expect.objectContaining({
      table: "ACCOBJECTS", column: "OPENDEBIT", nulls: 1, rows: 1, status: "poisoned",
    }));
    expect(report.rows).toContainEqual(expect.objectContaining({
      table: "ACCOBJECTS", column: "OPENCREDIT", nulls: 1, rows: 1, status: "poisoned",
    }));
    expect(report.rows).toContainEqual(expect.objectContaining({
      table: "ACCTOTALS", column: "DEBIT", nulls: 0, status: "clean",
    }));
    // A target table the corpus does not hold is named, never silently counted clean.
    expect(report.rows).toContainEqual(expect.objectContaining({
      table: "MATCOSTS", column: "COST", nulls: 0, rows: 0, status: "source_absent",
    }));
  });

  it("summarises the blast radius in strings", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "null_poison");
    // ACCTOTALS.CREDIT (nulled in Step 1), ACCOBJECTS.OPENDEBIT, ACCOBJECTS.OPENCREDIT (Task 7's corpus row)
    // and MATOBJECTS.QNT — one NULL each.
    expect(report.summary.poisonedColumns).toBe("4");
    expect(report.summary.poisonedValues).toBe("4");
    expect(report.summary.note).toContain("blank or zero, not as errors");
  });
});
```

`packages/importer/test/duplicate-aggregates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { reconcile } from "../src/reconcile";
import { loadCorpus } from "./support/corpus";

describe("reconcile('duplicate_aggregates') — §5.1 #5, LEGACY-049", () => {
  it("finds a natural key that appears more than once in a keyless aggregate table", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "duplicate_aggregates");
    expect(report.rows).toContainEqual({
      table: "MATOBJECTS", key: "5|1", naturalKey: "MATERIAL,WAREHOUSE", occurrences: 2, status: "duplicate",
      why: "MatObjects and MatQuantity have no key columns, and the non-atomic UPDATE-then-INSERT upsert duplicates under concurrency; every later posting then updates both rows (LEGACY-049).",
    });
  });

  it("reports each table's row count so a clean table is visibly clean, not merely absent", async () => {
    const report = await reconcile(await createReader(new FixtureLegacyDriver(loadCorpus())), "duplicate_aggregates");
    expect(report.summary.duplicatedKeys).toBe("1");
    expect(report.summary.excessRows).toBe("1");
    expect(report.rows).toContainEqual(expect.objectContaining({ table: "MATQUANTITY", status: "source_absent" }));
  });
});
```

- [ ] **Step 3: Run both and see them fail**

Run: `bun run --cwd packages/importer test -- null-poison duplicate`
Expected: FAIL — both kinds unimplemented.

- [ ] **Step 4: Write `packages/importer/src/reconcile/null-poison.ts`**

```ts
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import { hasColumns } from "./probe";
import type { ReconciliationReport } from "./index";

export interface NullPoisonTarget { readonly table: string; readonly columns: readonly string[]; readonly why: string; readonly legacyDefects: readonly string[] }

/**
 * §5.1 #4: "Expect NULL-poisoned balances and costs (LEGACY-007, 011). These will appear as blank or zero, not as
 * errors." (spec:2334) The list is every figure column a legacy report would render as a blank and a loader
 * would coerce to zero — which is the same defect arriving in the new system.
 */
export const NULL_POISON_TARGETS: readonly NullPoisonTarget[] = [
  { table: "ACCTOTALS", columns: ["DEBIT", "CREDIT", "ADMINDEBIT", "ADMINCREDIT"],
    why: "NULL arithmetic irreversibly nulls balances (LEGACY-011): one NULL operand in the trigger's -old + new expression wipes the accumulated figure and nothing raises.", legacyDefects: ["LEGACY-011"] },
  { table: "ACCOBJECTS", columns: ["DEBIT", "CREDIT", "OPENDEBIT", "OPENCREDIT"], why: "As ACCTOTALS.", legacyDefects: ["LEGACY-011"] },
  { table: "ACCCURTOTALS", columns: ["DEBIT", "CREDIT"], why: "As ACCTOTALS, per currency (LEGACY-001).", legacyDefects: ["LEGACY-001", "LEGACY-011"] },
  { table: "MATCOSTS", columns: ["COST", "BUY", "BUYPRICE", "SALEPRICE"],
    why: "Value-less production movements NULL-poison cost forever (LEGACY-007) and there is no rebuild path (LEGACY-004). A NULL here is why §5.1 #6 forbids importing cost at all.", legacyDefects: ["LEGACY-004", "LEGACY-007"] },
  { table: "MATOBJECTS", columns: ["QNT"], why: "A NULL quantity reads as zero stock and hides a position (LEGACY-050).", legacyDefects: ["LEGACY-050"] },
  { table: "MATQUANTITY", columns: ["QNT"], why: "As MATOBJECTS, per batch.", legacyDefects: ["LEGACY-049", "LEGACY-050"] },
  { table: "VOUITEMS", columns: ["DEBIT", "CREDIT", "LOCALDEBIT", "LOCALCREDIT"],
    why: "A NULL on a line is what poisons every aggregate downstream; LocalDebit/LocalCredit additionally were never derived from value × rate (LEGACY-012).", legacyDefects: ["LEGACY-011", "LEGACY-012"] },
  { table: "BILLITEMS", columns: ["QNT", "DEBIT", "CREDIT", "LOCALCOST", "ACTUALCOST"],
    why: "As VOUITEMS, on the inventory side; the three cost columns feed MatCosts.", legacyDefects: ["LEGACY-007", "LEGACY-011"] },
];

export async function nullPoison(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let poisonedColumns = 0;
  let poisonedValues = 0;

  for (const target of NULL_POISON_TARGETS) {
    for (const column of target.columns) {
      if (!(await hasColumns(reader, target.table, [column]))) {
        rows.push({ table: target.table, column, nulls: 0, rows: 0, status: "source_absent", why: target.why });
        continue;
      }
      let nulls = 0;
      let total = 0;
      for await (const batch of reader.read<LegacyRow>(target.table, { columns: [column], batch: READ_BATCH })) {
        for (const row of batch) {
          total += 1;
          const value = row[column];
          if (value === null || value === undefined || value === "") nulls += 1;
        }
      }
      if (nulls > 0) { poisonedColumns += 1; poisonedValues += nulls; }
      rows.push({ table: target.table, column, nulls, rows: total, status: nulls > 0 ? "poisoned" : "clean", why: target.why });
    }
  }

  return {
    kind: "null_poison", rows,
    summary: {
      columns: String(rows.length), poisonedColumns: String(poisonedColumns), poisonedValues: String(poisonedValues),
      note: "These appear as blank or zero, not as errors (§5.1 #4). 9B refuses to coerce a NULL figure to zero: a row listed here is loaded only after the owner supplies the value or agrees to omit it.",
    },
  };
}
```

- [ ] **Step 5: Write `packages/importer/src/reconcile/duplicate-aggregates.ts`**

```ts
import type { LegacyRow } from "../legacy/types";
import type { LegacyReader } from "../reader";
import { READ_BATCH } from "./aggregate-drift";
import { hasColumns } from "./probe";
import type { ReconciliationReport } from "./index";

export interface DuplicateTarget { readonly table: string; readonly naturalKey: readonly string[]; readonly why: string; readonly legacyDefects: readonly string[] }

const RACE =
  "MatObjects and MatQuantity have no key columns, and the non-atomic UPDATE-then-INSERT upsert duplicates " +
  "under concurrency; every later posting then updates both rows (LEGACY-049).";

/**
 * §5.1 #5: "Expect duplicate aggregate rows for MatObjects/MatQuantity (LEGACY-049)." (spec:2335) The natural key
 * is what the trigger's WHERE clause *meant*; the table has no unique index enforcing it, which is the defect.
 */
export const DUPLICATE_TARGETS: readonly DuplicateTarget[] = [
  { table: "MATOBJECTS", naturalKey: ["MATERIAL", "WAREHOUSE"], why: RACE, legacyDefects: ["LEGACY-049"] },
  { table: "MATQUANTITY", naturalKey: ["MATERIAL", "WAREHOUSE", "BATCH"], why: RACE, legacyDefects: ["LEGACY-049"] },
  { table: "ACCOBJECTS", naturalKey: ["SITE", "ACCOUNT"], why: "AccObjects does have key columns, so a duplicate here would mean the index is absent in this database — worth knowing before the load (LEGACY-049, Part VII #6).", legacyDefects: ["LEGACY-049"] },
  { table: "ACCTOTALS", naturalKey: ["ACCOUNT"], why: "As ACCOBJECTS.", legacyDefects: ["LEGACY-049"] },
  { table: "MATTOTALS", naturalKey: ["MATERIAL"], why: "As ACCOBJECTS, on the inventory side.", legacyDefects: ["LEGACY-049"] },
];

export async function duplicateAggregates(reader: LegacyReader): Promise<ReconciliationReport> {
  const rows: Record<string, unknown>[] = [];
  let duplicatedKeys = 0;
  let excessRows = 0;

  for (const target of DUPLICATE_TARGETS) {
    if (!(await hasColumns(reader, target.table, target.naturalKey))) {
      rows.push({ table: target.table, key: null, naturalKey: target.naturalKey.join(","), occurrences: 0, status: "source_absent", why: target.why });
      continue;
    }
    const counts = new Map<string, number>();
    for await (const batch of reader.read<LegacyRow>(target.table, { columns: [...target.naturalKey], batch: READ_BATCH })) {
      for (const row of batch) {
        const k = target.naturalKey.map((c) => String(row[c] ?? "")).join("|");
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
    for (const [k, occurrences] of [...counts].sort(([a], [b]) => a.localeCompare(b, "en"))) {
      if (occurrences < 2) continue;
      duplicatedKeys += 1;
      excessRows += occurrences - 1;
      rows.push({ table: target.table, key: k, naturalKey: target.naturalKey.join(","), occurrences, status: "duplicate", why: target.why });
    }
  }

  return {
    kind: "duplicate_aggregates", rows,
    summary: {
      tables: String(DUPLICATE_TARGETS.length), duplicatedKeys: String(duplicatedKeys), excessRows: String(excessRows),
      note: "Every duplicated key has been counted twice by every posting since it appeared (LEGACY-049), so the drift report's figure for that key is wrong on the stored side by exactly the excess. Read the two reports together.",
    },
  };
}
```

- [ ] **Step 6: Add both cases, run everything, commit**

`case "null_poison": return nullPoison(reader);` and `case "duplicate_aggregates": return duplicateAggregates(reader);`.

Run: `bun run --cwd packages/importer test`
Expected: PASS — the whole package, including Task 7's suite with `drifting` at `2` and 23 rows after Step 1's
one-line edit, and `profile`/`scope`, which correction C1 (Task 7 Step 1) already made growth-proof.

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```
feat(importer): detect NULL-poisoned figures and duplicate aggregate rows [9A T10]

§5.1 #4 and #5. NULL counts per figure column with the reason a NULL is there, because
these "appear as blank or zero, not as errors"; and per-natural-key occurrence counts
over the five aggregate tables, including the two LEGACY-049 names that have no key
columns at all. The two reports are meant to be read together: a duplicated key makes
the drift report's stored figure wrong by exactly the excess.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 11: The employee duplicate-mapping report (§5.1 #12) — and the dispatcher becomes exhaustive

**Files:**
- Create: `packages/importer/src/reconcile/employee-mapping.ts`
- Modify: `packages/importer/src/reconcile/index.ts` (the sixth case; the `default` branch is **deleted**), `packages/importer/src/index.ts` (**Step 7** — the employee-mapping group, one line), `packages/importer/src/cli.ts` (validate `--kind` against `RECONCILIATION_KINDS`), `packages/importer/test/corpus/base/catalog.json` (add `EMPLOYEES`), `packages/importer/test/corpus/base/ACCOUNTS.json` (two rows), `packages/importer/test/profile.test.ts` and `packages/importer/test/scope.test.ts` (**two one-line edits**, Step 1)
- Create: `packages/importer/test/corpus/base/EMPLOYEES.json`
- Test: `packages/importer/test/employee-mapping.test.ts`

**Interfaces:**
- Consumes: `LegacyReader` (T4), `ReconciliationReport`/`RECONCILIATION_KINDS` (T7), `unreadable` (T1).
- Produces:
  ```ts
  export type EmployeeMatchStatus =
    | "matched_by_account" | "matched_by_name" | "hr_only" | "account_only" | "ambiguous_name";
  export interface EmployeeMatchStrategy {
    readonly id: "account_column" | "normalised_name";
    readonly derivation: string;
    readonly confidence: "verified" | "hypothesis" | "not_derivable";
  }
  export const EMPLOYEE_MATCH_STRATEGIES: readonly EmployeeMatchStrategy[];
  export function normaliseLegacyName(value: string): string;
  export async function employeeMapping(reader: LegacyReader): Promise<ReconciliationReport>;
  ```

**Why this report exists.** spec:2344, §5.1 #12, verbatim: "**Employees exist twice in the legacy data** —
`Salaries.Employees` and `Accounts` rows flagged `IsEmployee` (§0.4). Map both to one `party` of kind employee
plus one `employee`; **report the rows that do not match rather than guessing.**" The dossier confirms both
sides exist — `Accounts` (~65 columns) carries the role flag `IsEmployee` among eighteen such flags (analysis
§4.2), and `Salaries` (36 tables) carries `Employees` and `Personnels` (analysis §4.5) — and **names no link
column between them**. Spec §0.4's glossary row is `` `Employees` / `Personnels` `` → "staff records (HR)" →
"**Employee** — a Party of kind employee, optional principal, home branch", which fixes the *target* shape and
says nothing about the *join*. So this task does what assumption 8 does for the aggregates: it declares each
match strategy as data with its own `confidence`, applies them in a fixed order, and prints the strategy that
matched on every row. **9B maps; 9A only reports.**

**Three one-line edits to earlier suites follow from Step 1's corpus growth, and they are the last three.**
Correction C1 (Task 7 Step 1) already replaced `profile.test.ts`'s and `scope.test.ts`' exact-array and
exact-count expectations with by-name lookups, so nothing here is about corpus *size*. What moves is content:

1. **`profile.test.ts`** — `expect(byName.get("ACCOUNTS")).toEqual({ name: "ACCOUNTS", rows: 3 })` becomes
   `rows: 5`. Step 1 adds accounts 13 and 14.
2. **`scope.test.ts`** — the `ACCOUNTS` by-name lookup's `rows: 3` becomes `rows: 5`. Nothing else on that
   object changes: `module` is still `"standard"`, `dateColumn` still `null`.
3. **`profile.test.ts`** — `expect(report.modulesInUse.salaries).toBe(false)` becomes `.toBe(true)`. This task
   puts rows in `EMPLOYEES`, which is a `Salaries` table, so the module *is* in use in the corpus. Keep
   `hospitals`/`academy` at `false` and keep `toHaveLength(17)`.

If either file is still pinning an exact array or an exact `missingTables` length, correction C1 was skipped —
go back to Task 7 Step 1 and apply it before making these three edits.

- [ ] **Step 1: Grow the corpus — the four cases the report must separate**

Add to `packages/importer/test/corpus/base/catalog.json`'s `tables` object:

```json
    "EMPLOYEES": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "NAME", "kind": "text", "scale": 0, "nullable": true },
        { "name": "ACCOUNT", "kind": "integer", "scale": 0, "nullable": true },
        { "name": "ORGANIC", "kind": "integer", "scale": 0, "nullable": true }
      ]
    }
```

`packages/importer/test/corpus/base/EMPLOYEES.json`:

```json
[
  { "SITE": "1", "ID": "5", "NAME": "Ali Hassan", "ACCOUNT": "12", "ORGANIC": "1" },
  { "SITE": "1", "ID": "6", "NAME": "  أحمد   سعيد ", "ACCOUNT": "0", "ORGANIC": "1" },
  { "SITE": "1", "ID": "7", "NAME": "Siti Nurhaliza", "ACCOUNT": null, "ORGANIC": "1" }
]
```

and add two rows to `packages/importer/test/corpus/base/ACCOUNTS.json`, keeping the three that are there:

```json
  { "SITE": "1", "ID": "13", "CODE": "2101", "NAME": "احمد سعيد", "ISEMPLOYEE": "1" },
  { "SITE": "1", "ID": "14", "CODE": "2102", "NAME": "Ravi Kumar", "ISEMPLOYEE": "1" }
```

The four outcomes are now all present in nine rows: employee 5 ↔ account 12 by the `ACCOUNT` column
(`matched_by_account`); employee 6 ↔ account 13 by name only, and only after normalisation strips the padding,
the doubled spaces and the alef hamza (`matched_by_name`); employee 7 matches nothing (`hr_only`); account 14
matches nothing (`account_only`). Account 12's name is `Ali Hassan` and matches employee 5 by *both* routes —
the report must not emit it twice.

- [ ] **Step 2: Write the failing test**

`packages/importer/test/employee-mapping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { RECONCILIATION_KINDS, reconcile } from "../src/reconcile";
import { EMPLOYEE_MATCH_STRATEGIES, normaliseLegacyName } from "../src/reconcile/employee-mapping";
import { loadCorpus } from "./support/corpus";

const reader = () => createReader(new FixtureLegacyDriver(loadCorpus()));

describe("normaliseLegacyName — the name match is a hypothesis, so its rule is testable in isolation", () => {
  it("collapses padding and doubled spaces, and upper-cases the Latin script", () => {
    expect(normaliseLegacyName("  Ali   Hassan ")).toBe("ALI HASSAN");
  });

  it("folds the Arabic forms a data-entry operator uses interchangeably", () => {
    expect(normaliseLegacyName("  أحمد   سعيد ")).toBe(normaliseLegacyName("احمد سعيد"));
    expect(normaliseLegacyName("إبراهيم")).toBe(normaliseLegacyName("ابراهيم"));
    expect(normaliseLegacyName("مصطفىٰ")).toBe(normaliseLegacyName("مصطفي"));
    expect(normaliseLegacyName("فاطمة")).toBe(normaliseLegacyName("فاطمه"));
    expect(normaliseLegacyName("محمــــد")).toBe(normaliseLegacyName("محمد"));
  });

  it("does not fold two genuinely different names together", () => {
    expect(normaliseLegacyName("Ali Hassan")).not.toBe(normaliseLegacyName("Ali Hussain"));
  });
});

describe("reconcile employee_mapping — §5.1 #12", () => {
  it("reports every row exactly once, with the strategy that matched it", async () => {
    const report = await reconcile(await reader(), "employee_mapping");
    expect(report.kind).toBe("employee_mapping");
    expect(report.rows).toEqual([
      { employeeId: "1/5", employeeName: "Ali Hassan", accountId: "1/12", accountCode: "2100",
        accountName: "Ali Hassan", status: "matched_by_account", strategy: "account_column",
        confidence: "hypothesis" },
      { employeeId: "1/6", employeeName: "أحمد   سعيد", accountId: "1/13", accountCode: "2101",
        accountName: "احمد سعيد", status: "matched_by_name", strategy: "normalised_name",
        confidence: "hypothesis" },
      { employeeId: "1/7", employeeName: "Siti Nurhaliza", accountId: null, accountCode: null,
        accountName: null, status: "hr_only", strategy: null, confidence: null },
      { employeeId: null, employeeName: null, accountId: "1/14", accountCode: "2102",
        accountName: "Ravi Kumar", status: "account_only", strategy: null, confidence: null },
    ]);
  });

  it("summarises the four outcomes as strings, and says what the owner must do with them", async () => {
    const report = await reconcile(await reader(), "employee_mapping");
    expect(report.summary).toEqual({
      hrRows: "3", accountRows: "3", matchedByAccount: "1", matchedByName: "1",
      hrOnly: "1", accountOnly: "1", ambiguousNames: "0",
      note: "Every unmatched row is a decision for the owner: 9B maps a matched pair to one party of kind employee plus one employee, and refuses to guess for the rest (§5.1 #12).",
    });
    expect(Object.values(report.summary).every((v) => typeof v === "string")).toBe(true);
  });

  it("declares both strategies as hypotheses — the link column is not in the spec or the dossier", () => {
    expect(EMPLOYEE_MATCH_STRATEGIES.map((s) => [s.id, s.confidence])).toEqual([
      ["account_column", "hypothesis"],
      ["normalised_name", "hypothesis"],
    ]);
    for (const strategy of EMPLOYEE_MATCH_STRATEGIES) expect(strategy.derivation.length).toBeGreaterThan(40);
  });

  it("has an implementation for all six kinds now, so the dispatcher needs no fallback", async () => {
    expect(RECONCILIATION_KINDS).toHaveLength(6);
    for (const kind of RECONCILIATION_KINDS) {
      expect((await reconcile(await reader(), kind)).kind).toBe(kind);
    }
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `bun run --cwd packages/importer test employee-mapping`
Expected: FAIL — `Cannot find module '../src/reconcile/employee-mapping'`.

- [ ] **Step 4: Write `packages/importer/src/reconcile/employee-mapping.ts`**

```ts
import type { LegacyReader } from "../reader";
import type { ReconciliationReport } from "./index";

export type EmployeeMatchStatus =
  | "matched_by_account" | "matched_by_name" | "hr_only" | "account_only" | "ambiguous_name";

export interface EmployeeMatchStrategy {
  readonly id: "account_column" | "normalised_name";
  readonly derivation: string;
  readonly confidence: "verified" | "hypothesis" | "not_derivable";
}

/**
 * Applied in this order, first match wins. Both are `hypothesis` and neither is promoted by this plan:
 * spec §0.4 fixes the *target* ("Employee — a Party of kind employee, optional principal, home branch") and
 * the dossier lists both source tables, but **no shipped file names a link column** between `Salaries.Employees`
 * and an `Accounts` row flagged `IsEmployee`. Assumption 8's rule applies unchanged — the derivation is stated
 * in English on the row, the confidence travels with it, and the owner confirms or corrects it. 9B is what
 * finally maps; a `hypothesis` that survives the owner's review is the input it maps from.
 */
export const EMPLOYEE_MATCH_STRATEGIES: readonly EmployeeMatchStrategy[] = [
  { id: "account_column", confidence: "hypothesis",
    derivation: "EMPLOYEES.ACCOUNT, when present and neither 0 nor null, is read as ACCOUNTS.ID within the same SITE. The column exists in the shipped schema; that it holds an account id rather than an account code is the hypothesis." },
  { id: "normalised_name", confidence: "hypothesis",
    derivation: "EMPLOYEES.NAME equals ACCOUNTS.NAME after normaliseLegacyName, among accounts flagged IsEmployee. A name is not a key; a match here is evidence, and two HR rows normalising onto one account are reported as ambiguous_name rather than resolved." },
];

const ARABIC_FOLD: readonly (readonly [RegExp, string])[] = [
  [/[ً-ْٰۖ-ۭ]/g, ""],   // harakat and Quranic marks: decorative, inconsistently typed
  [/ـ/g, ""],                                // tatweel: a stretching glyph with no phonetic value
  [/[آأإٱ]/g, "ا"],      // آ أ إ ٱ  → ا
  [/[ى]/g, "ي"],                        // ى → ي
  [/[ة]/g, "ه"],                        // ة → ه
  [/[ؤ]/g, "و"],                        // ؤ → و
];

/**
 * The one place a legacy name is folded, so the rule is testable on its own and identical on both sides of the
 * join. Arabic master data in this source was typed over two decades by many hands: the same person appears as
 * `أحمد` and `احمد`, `فاطمة` and `فاطمه`, with tatweel padding and double spaces. Folding those forms is not a
 * guess about *this* customer's data; not folding them would report every such pair as two unmatched rows and
 * bury the real exceptions. Latin text is upper-cased with the invariant locale so a Turkish `i` cannot change
 * the answer depending on where the extraction runs.
 */
export function normaliseLegacyName(value: string): string {
  let out = value.normalize("NFC");
  for (const [pattern, replacement] of ARABIC_FOLD) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim().toLocaleUpperCase("en-US");
}

interface Side { readonly site: string; readonly id: string; readonly name: string; readonly code: string | null; readonly account: string | null }

const ref = (row: Side): string => [row.site, row.id].join("/");

async function collect(reader: LegacyReader, table: string, columns: string[]): Promise<Record<string, string | null>[]> {
  const out: Record<string, string | null>[] = [];
  for await (const batch of reader.read<Record<string, string | boolean | null>>(table, { columns, batch: 500 })) {
    for (const row of batch) {
      const flat: Record<string, string | null> = {};
      for (const column of columns) {
        const value = row[column];
        flat[column] = value === null || value === undefined ? null : String(value);
      }
      out.push(flat);
    }
  }
  return out;
}

/**
 * §5.1 #12 (spec:2344): "Employees exist twice in the legacy data — Salaries.Employees and Accounts rows
 * flagged IsEmployee. Map both to one party of kind employee plus one employee; **report the rows that do not
 * match rather than guessing**." This function does the reporting half and none of the mapping half.
 *
 * A row appears exactly once. The order is: matched pairs in HR-row order, then the HR rows that matched
 * nothing, then the accounts that matched nothing — so the file reads as "these are settled, these two lists
 * are your decisions". Part VII #13 (is the Salaries module live at all?) is answered by Task 13's probe, not
 * here: this report is correct and useful when `EMPLOYEES` is empty, and then every flagged account is
 * `account_only`, which is exactly the picture a customer who never used the Salaries module should see.
 */
export async function employeeMapping(reader: LegacyReader): Promise<ReconciliationReport> {
  const present = new Set(await reader.tables());

  const hr: Side[] = present.has("EMPLOYEES")
    ? (await collect(reader, "EMPLOYEES", ["SITE", "ID", "NAME", "ACCOUNT"])).map((r) => ({
        site: r.SITE ?? "", id: r.ID ?? "", name: (r.NAME ?? "").trim(), code: null,
        account: r.ACCOUNT === null || r.ACCOUNT === "0" ? null : r.ACCOUNT,
      }))
    : [];

  const accounts: Side[] = present.has("ACCOUNTS")
    ? (await collect(reader, "ACCOUNTS", ["SITE", "ID", "CODE", "NAME", "ISEMPLOYEE"]))
        .filter((r) => r.ISEMPLOYEE === "1")
        .map((r) => ({ site: r.SITE ?? "", id: r.ID ?? "", name: (r.NAME ?? "").trim(), code: r.CODE, account: null }))
    : [];

  const byId = new Map(accounts.map((a) => [ref(a), a] as const));
  const byName = new Map<string, Side[]>();
  for (const account of accounts) {
    const key = normaliseLegacyName(account.name);
    byName.set(key, [...(byName.get(key) ?? []), account]);
  }

  const rows: Record<string, unknown>[] = [];
  const claimed = new Set<string>();
  const counters = { matched_by_account: 0, matched_by_name: 0, hr_only: 0, account_only: 0, ambiguous_name: 0 };

  const emit = (
    employee: Side | null, account: Side | null, status: EmployeeMatchStatus,
    strategy: EmployeeMatchStrategy | null,
  ): void => {
    counters[status] += 1;
    rows.push({
      employeeId: employee ? ref(employee) : null,
      employeeName: employee ? employee.name : null,
      accountId: account ? ref(account) : null,
      accountCode: account?.code ?? null,
      accountName: account ? account.name : null,
      status, strategy: strategy?.id ?? null, confidence: strategy?.confidence ?? null,
    });
  };

  for (const employee of hr) {
    const declared = employee.account === null ? undefined : byId.get([employee.site, employee.account].join("/"));
    if (declared && !claimed.has(ref(declared))) {
      claimed.add(ref(declared));
      emit(employee, declared, "matched_by_account", EMPLOYEE_MATCH_STRATEGIES[0] as EmployeeMatchStrategy);
      continue;
    }
    const candidates = (byName.get(normaliseLegacyName(employee.name)) ?? []).filter((a) => !claimed.has(ref(a)));
    if (candidates.length === 1) {
      const only = candidates[0] as Side;
      claimed.add(ref(only));
      emit(employee, only, "matched_by_name", EMPLOYEE_MATCH_STRATEGIES[1] as EmployeeMatchStrategy);
      continue;
    }
    if (candidates.length > 1) {
      // Two or more flagged accounts share this name. Resolving it by picking the lowest id is precisely the
      // "guessing" §5.1 #12 forbids: the file names every candidate and the owner says which is which.
      emit(employee, null, "ambiguous_name", EMPLOYEE_MATCH_STRATEGIES[1] as EmployeeMatchStrategy);
      rows[rows.length - 1] = {
        ...rows[rows.length - 1],
        accountId: candidates.map((a) => ref(a)).join(" "),
        accountName: candidates.map((a) => a.name).join(" | "),
      };
      continue;
    }
    emit(employee, null, "hr_only", null);
  }

  for (const account of accounts) {
    if (!claimed.has(ref(account))) emit(null, account, "account_only", null);
  }

  return {
    kind: "employee_mapping", rows,
    summary: {
      hrRows: String(hr.length), accountRows: String(accounts.length),
      matchedByAccount: String(counters.matched_by_account), matchedByName: String(counters.matched_by_name),
      hrOnly: String(counters.hr_only), accountOnly: String(counters.account_only),
      ambiguousNames: String(counters.ambiguous_name),
      note: "Every unmatched row is a decision for the owner: 9B maps a matched pair to one party of kind employee plus one employee, and refuses to guess for the rest (§5.1 #12).",
    },
  };
}
```

- [ ] **Step 5: Complete the dispatcher and delete its fallback**

`packages/importer/src/reconcile/index.ts` — add the import and the sixth case, then **delete the `default`
branch** Task 7 wrote. All six members of the union now have an implementation, so TypeScript narrows `kind`
to `never` after the last case and the function is provably total; a `default` from here on would be
unreachable code that hides a future missing case instead of failing the build:

```ts
import { employeeMapping } from "./employee-mapping";
```

```ts
export async function reconcile(reader: LegacyReader, kind: ReconciliationReport["kind"]): Promise<ReconciliationReport> {
  switch (kind) {
    case "aggregate_drift": return aggregateDrift(reader);
    case "unbalanced_vouchers": return unbalancedVouchers(reader);
    case "orphans": return orphans(reader);
    case "null_poison": return nullPoison(reader);
    case "duplicate_aggregates": return duplicateAggregates(reader);
    case "employee_mapping": return employeeMapping(reader);
  }
}
```

- [ ] **Step 6: Stop the CLI casting an unvalidated string into the union**

Task 7's `reconcile` branch wrote `[requested as (typeof RECONCILIATION_KINDS)[number]]`, which used to land in
the deleted `default`; with the switch exhaustive, a typo would now fall out of the bottom and return
`undefined`. Replace those two lines in `packages/importer/src/cli.ts` with a validated lookup:

```ts
      const requested = args.flags.kind ?? "all";
      const isKind = (value: string): value is (typeof RECONCILIATION_KINDS)[number] =>
        (RECONCILIATION_KINDS as readonly string[]).includes(value);
      if (requested !== "all" && !isKind(requested)) {
        console.error(["config: unknown --kind", requested, "— expected all or one of",
          RECONCILIATION_KINDS.join(", ")].join(" "));
        return EXIT_CONFIG;
      }
      const kinds = requested === "all" ? RECONCILIATION_KINDS : [requested];
```

- [ ] **Step 7: Add the export to the barrel**

In `packages/importer/src/index.ts`:

```ts
export { EMPLOYEE_MATCH_STRATEGIES, employeeMapping, normaliseLegacyName,
  type EmployeeMatchStatus, type EmployeeMatchStrategy } from "./reconcile/employee-mapping";
```

- [ ] **Step 8: Apply the three one-line edits, run everything, commit**

Apply the three edits to `profile.test.ts` and `scope.test.ts` exactly as listed at the top of this task.

Run: `bun run --cwd packages/importer test`
Expected: PASS — every suite. `profile` and `scope` were made insensitive to corpus size by correction C1 at
Task 7 Step 1 and now carry the right `ACCOUNTS` count and the `salaries` flip; `aggregate-drift`'s `summary`
counters do not move, because `EMPLOYEES` and the two new `ACCOUNTS` rows carry no column any rule reads.

Run: `bun run legacy reconcile --kind employee_mapping --fixture base --out artefacts/legacy/dev`
Expected: `employee_mapping : 4 findings — hrRows=3 accountRows=3 matchedByAccount=1 matchedByName=1 hrOnly=1 accountOnly=1 ambiguousNames=0 note=…` then a `wrote:` line.

Run: `bun run legacy reconcile --kind employees --fixture base`
Expected: exit 2 and `config: unknown --kind employees — expected all or one of aggregate_drift, unbalanced_vouchers, orphans, null_poison, duplicate_aggregates, employee_mapping`.

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```
feat(importer): report the legacy employee duplicate mapping [9A T11]

§5.1 #12 — employees exist twice, as Salaries.Employees and as Accounts rows flagged
IsEmployee, and no shipped file names the link column. Both match strategies are
declared as data with confidence `hypothesis` and the matching strategy is printed on
every row; two flagged accounts sharing one name are reported as ambiguous rather than
resolved by picking an id. Completes the six-member dispatcher, so its fallback branch
is deleted and the CLI validates --kind instead of casting it. Moves ACCOUNTS from 3 to
5 rows in both by-name expectations and flips modulesInUse.salaries to true.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 12: The report-template catalogue — blobs out of `System.Reports` (§5.1 #9, LEGACY-077)

**Files:**
- Create: `packages/importer/src/catalogue/templates.ts`
- Modify: `packages/importer/src/drivers/odbc.ts` (**correction C2** — blob values), `packages/importer/src/cli.ts` (the `templates` command), `packages/importer/src/index.ts` (one export), `packages/importer/test/corpus/base/catalog.json` + a new `REPORTS.json`, `tests/package.json` (one dependency)
- Create **or append**: `tests/regression/legacy-077.test.ts` (§3.7.3 first corollary)
- Test: `packages/importer/test/templates.test.ts`

**Interfaces:**
- Consumes: `LegacyDriver`/`LegacyColumn` (T1), `ReportWriter`/`ArtefactEntry` (T5), `unreadable` (T1).
- Produces:
  ```ts
  export interface TemplateEntry {
    readonly name: string;                 // the row's name column, trimmed
    readonly owner: string | null;         // the per-user owner, when the table declares such a column
    readonly bytes: number;                // decoded blob length
    readonly sha256: string;               // of the decoded bytes
    readonly file: string;                 // the artefact file the blob was written to
    readonly group: TemplateGroup;         // the dossier's §4.4 grouping, by rule
    readonly customisation: boolean;       // spr*/rah*/dnt*/med* — customer-specific (Part VII #9)
    readonly nearDuplicateOf: string | null;
    readonly empty: boolean;               // a row whose blob is null or zero-length
  }
  export type TemplateGroup =
    | "accounts" | "materials" | "documents" | "payroll" | "hospital" | "academy"
    | "services" | "fixed_assets" | "tax" | "customisation" | "unknown";
  export interface TemplateCatalogue {
    readonly generatedAt: string;
    readonly source: string;
    readonly table: string;
    readonly nameColumn: string;
    readonly blobColumn: string;
    readonly ownerColumn: string | null;
    readonly entries: readonly TemplateEntry[];
    readonly byGroup: Readonly<Record<TemplateGroup, number>>;
    readonly shippedCountFromDossier: 255;
    readonly note: string;
  }
  export const TEMPLATE_GROUP_RULES: readonly { readonly group: TemplateGroup; readonly test: RegExp; readonly why: string }[];
  export function classifyTemplate(name: string): { group: TemplateGroup; customisation: boolean };
  export function templateStem(name: string): string;
  export async function catalogueTemplates(driver: LegacyDriver, writer: ReportWriter): Promise<TemplateCatalogue>;
  ```

**Why this report exists, and why it is early.** spec:2341, §5.1 #9: "**Report definitions live as blobs in the
customer's database** (LEGACY-077). Extract and catalogue them early — it is the only way to know which of the 255
templates the customer actually uses." The dossier: "`.report` files are serialised Delphi objects
(`TDluxReportContainer`) with embedded DFM strings. They cannot be version-controlled meaningfully, diffed,
code-reviewed, or rendered outside the Dlux engine, and 255 of them exist — including near-duplicates
(`2.VouEntiers` vs `VouEntiers`, `AccMovement` vs `AccMovementHorizontal` vs `AccMovementInfo`, `BatchBalances`
vs `BatchBalances_n`)" (analysis §7.10), and "per-user report definitions are stored in `System.Reports`"
(analysis §4.4). Contracts §6.3 lets 9A run before or after 7A, and this catalogue is what 7B maps legacy
templates from — so it ships here whichever order the phases run in.

**What this task does not do.** It does **not** parse a `TDluxReportContainer`. The bytes are written out
verbatim, hashed and catalogued; whoever builds 7B decides what, if anything, to read out of them, and this
plan claims nothing about their structure beyond "opaque bytes with a name beside them". It also does not
decide which of the 255 the customer *uses* — presence with a non-empty blob is the evidence; the answer is
Part VII #8, which is **OD-27, Task 13**.

**Correction C2 (a defect this task fixes).** Task 3's `coerce` turns every non-`number`, non-`Date` ODBC value
into `String(value).trim()`. A Firebird `BLOB SUB_TYPE 0` arrives from `odbc` as a `Buffer`, and
`String(buffer)` is a lossy UTF-8 decode that silently corrupts every byte above 0x7F — which for a serialised
Delphi object is most of them. `CAST_WIDTH.blob` is already `null`, so the renderer does not cast it; the
driver must carry it. `LegacyScalar` stays `string | boolean | null` (spec:99's reason for excluding `number`
applies unchanged), so a blob crosses the seam as **base64**, and the catalogue is what knows to decode it —
`columns(table)` already declares the column `blob`. Replace the body of `coerce` in
`packages/importer/src/drivers/odbc.ts` with:

```ts
function coerce(row: Record<string, unknown>, table: string): LegacyRow {
  const out: Record<string, string | boolean | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number") throw unreadable(`${table}.${key} arrived as a JavaScript number; the varchar cast was lost`);
    if (value === null || value === undefined) out[key] = null;
    else if (typeof value === "boolean") out[key] = value;
    else if (value instanceof Date) throw unreadable(`${table}.${key} arrived as a Date; the varchar cast was lost`);
    // A blob column is the one thing the renderer deliberately does not cast (CAST_WIDTH.blob === null).
    // `String(buffer)` would be a lossy UTF-8 decode of a serialised Delphi object; base64 crosses the seam
    // losslessly and keeps LegacyScalar free of a Buffer member (correction C2, task 12).
    else if (value instanceof Uint8Array) out[key] = Buffer.from(value).toString("base64");
    else out[key] = String(value).trim();
  }
  return out;
}
```

- [ ] **Step 1: Grow the corpus with a `REPORTS` table whose blobs are base64**

Add to `packages/importer/test/corpus/base/catalog.json`'s `tables` object:

```json
    "REPORTS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "NAME", "kind": "text", "scale": 0, "nullable": true },
        { "name": "USERNAME", "kind": "text", "scale": 0, "nullable": true },
        { "name": "DEFINITION", "kind": "blob", "scale": 0, "nullable": true }
      ]
    }
```

`packages/importer/test/corpus/base/REPORTS.json` — the blob values are base64 of nine-byte strings whose
bytes deliberately include `0xFF`, so a lossy `String(buffer)` decode shows up as a hash mismatch. Nine bytes
is not arbitrary: it is a multiple of three, so the base64 is exactly twelve characters with **no `=`
padding**, and `Buffer.from(bytes).toString("base64")` round-trips to the identical string. A value with
padding would decode leniently to a different length than the literal suggests and the byte-count assertion
below would be wrong for a reason that has nothing to do with the code under test.

```json
[
  { "SITE": "1", "ID": "1", "NAME": "AccMovement", "USERNAME": "SYSDBA", "DEFINITION": "VER1/+AAECAw" },
  { "SITE": "1", "ID": "2", "NAME": "AccMovementHorizontal", "USERNAME": "SYSDBA", "DEFINITION": "VER1/+AAECBA" },
  { "SITE": "1", "ID": "3", "NAME": "2.VouEntiers", "USERNAME": "ahmad", "DEFINITION": "VER1/+AAECBQ" },
  { "SITE": "1", "ID": "4", "NAME": "sprAccTargets", "USERNAME": "ahmad", "DEFINITION": "VER1/+AAECBg" },
  { "SITE": "1", "ID": "5", "NAME": "MatBalances", "USERNAME": null, "DEFINITION": null }
]
```

- [ ] **Step 2: Write the failing test**

`packages/importer/test/templates.test.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportWriter } from "../src/artefacts";
import { catalogueTemplates, classifyTemplate, templateStem } from "../src/catalogue/templates";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { loadCorpus } from "./support/corpus";

const run = () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-9a-tpl-"));
  const writer = new ReportWriter(dir, { source: "fixture corpus", engineVersion: "Firebird 2.5" });
  return { dir, writer, driver: new FixtureLegacyDriver(loadCorpus()) };
};

describe("classifyTemplate — the dossier's §4.4 grouping, applied by rule not by list", () => {
  it("groups the names the dossier names", () => {
    expect(classifyTemplate("AccBalances")).toEqual({ group: "accounts", customisation: false });
    expect(classifyTemplate("BalanceSheets")).toEqual({ group: "accounts", customisation: false });
    expect(classifyTemplate("MatProfits")).toEqual({ group: "materials", customisation: false });
    expect(classifyTemplate("Inventory1")).toEqual({ group: "materials", customisation: false });
    expect(classifyTemplate("Tax.BillSaleForm")).toEqual({ group: "documents", customisation: false });
    expect(classifyTemplate("GstListingReport")).toEqual({ group: "tax", customisation: false });
    expect(classifyTemplate("hsprVisits")).toEqual({ group: "hospital", customisation: false });
    expect(classifyTemplate("StudentGradesRep")).toEqual({ group: "academy", customisation: false });
    expect(classifyTemplate("AstDepreciation")).toEqual({ group: "fixed_assets", customisation: false });
    expect(classifyTemplate("SalaryRep")).toEqual({ group: "payroll", customisation: false });
    expect(classifyTemplate("SrvMotion")).toEqual({ group: "services", customisation: false });
  });

  it("flags the customer-specific prefixes as customisations (Part VII #9)", () => {
    expect(classifyTemplate("sprAccTargets")).toEqual({ group: "customisation", customisation: true });
    expect(classifyTemplate("rahStockCalc")).toEqual({ group: "customisation", customisation: true });
    expect(classifyTemplate("repdntProfits")).toEqual({ group: "customisation", customisation: true });
  });

  it("says unknown rather than guessing", () => {
    expect(classifyTemplate("Zebra")).toEqual({ group: "unknown", customisation: false });
  });
});

describe("templateStem — the near-duplicate rule, checked against the dossier's own examples", () => {
  it("collapses the three families §7.10 names", () => {
    expect(templateStem("2.VouEntiers")).toBe(templateStem("VouEntiers"));
    expect(templateStem("AccMovementHorizontal")).toBe(templateStem("AccMovement"));
    expect(templateStem("AccMovementInfo")).toBe(templateStem("AccMovement"));
    expect(templateStem("BatchBalances_n")).toBe(templateStem("BatchBalances"));
  });

  it("keeps two unrelated names apart", () => {
    expect(templateStem("AccLedger")).not.toBe(templateStem("AccBalances"));
  });
});

describe("catalogueTemplates — §5.1 #9 / LEGACY-077", () => {
  it("writes every blob out byte-for-byte and hashes what it wrote", async () => {
    const { dir, writer, driver } = run();
    const catalogue = await catalogueTemplates(driver, writer);

    const acc = catalogue.entries.find((e) => e.name === "AccMovement");
    expect(acc).toMatchObject({
      owner: "SYSDBA", bytes: 9, group: "accounts", customisation: false,
      file: "templates/AccMovement.report", empty: false, nearDuplicateOf: "AccMovementHorizontal",
    });
    const written = readFileSync(join(dir, "templates", "AccMovement.report"));
    expect(written.toString("base64")).toBe("VER1/+AAECAw");
    expect(acc?.sha256).toBe(createHash("sha256").update(written).digest("hex"));
  });

  it("records a row whose blob is null as empty and writes no file for it", async () => {
    const { writer, driver } = run();
    const catalogue = await catalogueTemplates(driver, writer);
    expect(catalogue.entries.find((e) => e.name === "MatBalances")).toMatchObject({
      empty: true, bytes: 0, file: "", sha256: "", owner: null, group: "materials",
    });
  });

  it("discovers the name, owner and blob columns rather than assuming them", async () => {
    const { writer, driver } = run();
    const catalogue = await catalogueTemplates(driver, writer);
    expect(catalogue).toMatchObject({
      table: "REPORTS", nameColumn: "NAME", ownerColumn: "USERNAME", blobColumn: "DEFINITION",
      shippedCountFromDossier: 255,
    });
    expect(catalogue.byGroup).toEqual({
      accounts: 2, materials: 1, documents: 1, payroll: 0, hospital: 0, academy: 0,
      services: 0, fixed_assets: 0, tax: 0, customisation: 1, unknown: 0,
    });
  });

  it("refuses rather than reporting an empty catalogue when the table has no blob column", async () => {
    const corpus = loadCorpus();
    const stripped = {
      ...corpus,
      tables: { ...corpus.tables, REPORTS: {
        ...corpus.tables.REPORTS,
        columns: (corpus.tables.REPORTS?.columns ?? []).filter((c) => c.kind !== "blob"),
      } },
    };
    const { writer } = run();
    await expect(catalogueTemplates(new FixtureLegacyDriver(stripped), writer)).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: REPORTS declares no blob column; report definitions cannot be extracted/,
    );
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `bun run --cwd packages/importer test templates`
Expected: FAIL — `Cannot find module '../src/catalogue/templates'`.

- [ ] **Step 4: Write `packages/importer/src/catalogue/templates.ts`**

```ts
import { createHash } from "node:crypto";
import type { ReportWriter } from "../artefacts";
import { unreadable, type LegacyDriver } from "../legacy/types";

export type TemplateGroup =
  | "accounts" | "materials" | "documents" | "payroll" | "hospital" | "academy"
  | "services" | "fixed_assets" | "tax" | "customisation" | "unknown";

export interface TemplateEntry {
  readonly name: string;
  readonly owner: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly file: string;
  readonly group: TemplateGroup;
  readonly customisation: boolean;
  readonly nearDuplicateOf: string | null;
  readonly empty: boolean;
}

export interface TemplateCatalogue {
  readonly generatedAt: string;
  readonly source: string;
  readonly table: string;
  readonly nameColumn: string;
  readonly blobColumn: string;
  readonly ownerColumn: string | null;
  readonly entries: readonly TemplateEntry[];
  readonly byGroup: Readonly<Record<TemplateGroup, number>>;
  readonly shippedCountFromDossier: 255;
  readonly note: string;
}

/**
 * The dossier's own grouping (analysis §4.4), expressed as ordered rules rather than as a list of 255 names.
 * A rule can be checked against the dossier's examples in a test; a transcribed list of 255 strings cannot be
 * checked against anything and would rot the first time the customer renames a clone. The **customisation**
 * rules come first because `repdntProfits` matches both `rep*` and the `dnt` customisation and the answer that
 * matters for Part VII #9 is "customer-specific".
 */
export const TEMPLATE_GROUP_RULES: readonly { readonly group: TemplateGroup; readonly test: RegExp; readonly why: string }[] = [
  { group: "customisation", test: /(^|\.)(spr|rah)|dnt|(^|\.)med/i,
    why: "analysis §7.11: the Special/rah*/spr* modules and the dnt/med report families are customer-specific work (Part VII #9)." },
  { group: "tax", test: /^(gst|gulfvat|vat)/i,
    why: "analysis §4.4 names GstListingReport and GulfVat.Gst03Rep as the tax group." },
  { group: "hospital", test: /^(hsp|hspr|hh|patient|prescription|surgery|reception|room|storysick)/i,
    why: "analysis §4.4: ~25 hsp*/hspr* templates plus the clinic-facing names of the Hospitals module." },
  { group: "academy", test: /^(student|teacher|acad|class|semester|presence|lesson)/i,
    why: "analysis §4.4: ~10 academy templates, named for the Academy module's own entities." },
  { group: "fixed_assets", test: /^ast/i, why: "analysis §4.4: ~8 Ast* fixed-asset templates." },
  { group: "payroll", test: /^(salary|payroll|pay(cash|group|master|ment)|shifts|attend|vacation|promotion)/i,
    why: "analysis §4.4: ~20 payroll templates over the Salaries module's runs, advances and attendance." },
  { group: "services", test: /^(srv|mnt|service|transportservices|sky|aircraft|airport)/i,
    why: "analysis §4.4: ~15 services/maintenance templates, including the aviation sub-domain of §4.6." },
  { group: "documents", test: /(billprint|vouprint|billsaleform|buyorder|saleorder|transform|outbillform|voucherform|vouform|voufacedform|vouopenform|vouentiers|voureview|printbilmodels|printvoumodels|simplified)/i,
    why: "analysis §4.4's document group: the printed forms for bills and vouchers." },
  { group: "accounts", test: /^(acc|balancesheet|final|financequota|costcentre|operatingbalance|batchbalances|subacc|pend(payable|receivable))/i,
    why: "analysis §4.4: ~40 account templates — ledgers, balances, ages, statements." },
  { group: "materials", test: /^(mat|inventory|warehouse|regionsmovement|serial|prod|order(acc|funds|mat|product|rep|stagnant))/i,
    why: "analysis §4.4: ~45 material templates — balances, profits, movement, batches, serials, limits." },
];

/** Ordered rules, first match wins; `unknown` is a real answer and never a silent default into another group. */
export function classifyTemplate(name: string): { group: TemplateGroup; customisation: boolean } {
  const bare = name.trim();
  for (const rule of TEMPLATE_GROUP_RULES) {
    if (rule.test.test(bare)) return { group: rule.group, customisation: rule.group === "customisation" };
  }
  return { group: "unknown", customisation: false };
}

/**
 * The near-duplicate rule, derived from the three families analysis §7.10 names by example: a numeric clone
 * prefix (`2.VouEntiers`), an orientation or detail suffix (`AccMovementHorizontal`, `AccMovementInfo`) and a
 * `_n` revision suffix (`BatchBalances_n`). Two templates whose stems are equal are *candidates* for
 * consolidation — the dossier's "consolidate the 255 into ~60" — not proof that either is unused.
 */
export function templateStem(name: string): string {
  return name
    .trim()
    .replace(/^\d+\s*[.\-_]\s*/, "")
    .replace(/(_n|_\d+|horizontal|info|detail|details|short|long|simplified)$/i, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

const EMPTY_BY_GROUP: Readonly<Record<TemplateGroup, number>> = {
  accounts: 0, materials: 0, documents: 0, payroll: 0, hospital: 0, academy: 0,
  services: 0, fixed_assets: 0, tax: 0, customisation: 0, unknown: 0,
};

const NAME_CANDIDATES = ["NAME", "REPORTNAME", "CAPTION", "TITLE"] as const;
const OWNER_CANDIDATES = ["USERNAME", "USER", "OWNER", "PROFILE", "USERID"] as const;

/**
 * §5.1 #9 (spec:2341) / LEGACY-077. Takes the **driver**, not the `LegacyReader`: §4.13.1 froze `LegacyReader`
 * without a catalogue accessor, and this is the one report that needs a column's *declared type* — which
 * column is the blob is discovered, never assumed, because no shipped file gives `System.Reports`' column
 * names. Extending `LegacyReader` to suit one report would change a surface 9B consumes; taking the driver
 * changes nothing.
 *
 * The bytes are written out verbatim and hashed. Nothing here parses a `TDluxReportContainer` — the file is
 * opaque, and 7B decides later what to read out of it.
 */
export async function catalogueTemplates(driver: LegacyDriver, writer: ReportWriter): Promise<TemplateCatalogue> {
  const table = "REPORTS";
  if (!(await driver.tables()).includes(table)) {
    throw unreadable(`${table} is not a table of this source; report definitions cannot be extracted`);
  }
  const columns = await driver.columns(table);
  const blobColumn = columns.find((c) => c.kind === "blob")?.name;
  if (!blobColumn) throw unreadable(`${table} declares no blob column; report definitions cannot be extracted`);
  const nameColumn = NAME_CANDIDATES.find((c) => columns.some((col) => col.name === c))
    ?? columns.find((c) => c.kind === "text")?.name;
  if (!nameColumn) throw unreadable(`${table} declares no text column to read a template name from`);
  const ownerColumn = OWNER_CANDIDATES.find((c) => columns.some((col) => col.name === c && col.name !== nameColumn)) ?? null;

  const wanted = [nameColumn, blobColumn, ...(ownerColumn ? [ownerColumn] : [])];
  const staged: { name: string; owner: string | null; bytes: Buffer | null }[] = [];
  for await (const batch of driver.cursor({ table, columns: wanted }, 50)) {
    for (const row of batch) {
      const encoded = row[blobColumn];
      staged.push({
        name: String(row[nameColumn] ?? "").trim(),
        owner: ownerColumn === null || row[ownerColumn] === null ? null : String(row[ownerColumn]).trim(),
        bytes: typeof encoded === "string" && encoded.length > 0 ? Buffer.from(encoded, "base64") : null,
      });
    }
  }

  const stems = new Map<string, string[]>();
  for (const row of staged) {
    const stem = templateStem(row.name);
    stems.set(stem, [...(stems.get(stem) ?? []), row.name]);
  }

  const byGroup: Record<TemplateGroup, number> = { ...EMPTY_BY_GROUP };
  const entries: TemplateEntry[] = [];
  for (const row of staged) {
    const { group, customisation } = classifyTemplate(row.name);
    byGroup[group] += 1;
    const siblings = (stems.get(templateStem(row.name)) ?? []).filter((n) => n !== row.name);
    if (row.bytes === null) {
      entries.push({ name: row.name, owner: row.owner, bytes: 0, sha256: "", file: "", group, customisation,
        nearDuplicateOf: siblings[0] ?? null, empty: true });
      continue;
    }
    const file = ["templates/", safeFileName(row.name), ".report"].join("");
    writer.bytes(file, row.bytes);
    entries.push({
      name: row.name, owner: row.owner, bytes: row.bytes.byteLength,
      sha256: createHash("sha256").update(row.bytes).digest("hex"),
      file, group, customisation, nearDuplicateOf: siblings[0] ?? null, empty: false,
    });
  }

  return {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: driver.source, table, nameColumn, blobColumn, ownerColumn,
    entries, byGroup, shippedCountFromDossier: 255,
    note: "Presence with a non-empty blob is evidence a template exists here, not evidence it is used. Part VII #8 — which of the 255 are in use — is OD-27 and is answered by the questions probe. `nearDuplicateOf` marks consolidation candidates (analysis §7.10), never dead templates.",
  };
}

/** A template name can contain a dot, a space and Arabic text; a file name here may not contain a separator. */
function safeFileName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : ["unnamed-", createHash("sha256").update(name).digest("hex").slice(0, 12)].join("");
}
```

`ReportWriter.bytes` writes relative to the run directory, so `templates/AccMovement.report` needs the
subdirectory to exist. Add one line to `ReportWriter.write` in `packages/importer/src/artefacts.ts`, above
`writeFileSync` — `mkdirSync(dirname(join(this.outDir, name)), { recursive: true });` — and import `dirname`
from `node:path`. Nothing else in that class changes and `index.json` still lists every entry by its relative
name.

- [ ] **Step 5: Add the `templates` command and the export**

In `packages/importer/src/cli.ts`, a branch beside `reconcile`:

```ts
    if (args.command === "templates") {
      const reader = await createReader(driver, args.flags["firebird-version"]);
      const writer = new ReportWriter(out, { source: driver.source, engineVersion: reader.firebirdVersion });
      const catalogue = await catalogueTemplates(driver, writer);
      writer.json("templates.json", catalogue, catalogue.entries.length);
      writer.csv("templates.csv", catalogue.entries.map((e) => ({
        name: e.name, owner: e.owner ?? "", group: e.group, customisation: e.customisation ? "yes" : "no",
        bytes: e.bytes, empty: e.empty ? "yes" : "no", near_duplicate_of: e.nearDuplicateOf ?? "",
        sha256: e.sha256, file: e.file,
      })));
      const index = writer.finish();
      console.log(["templates:", String(catalogue.entries.length), "rows,",
        String(catalogue.entries.filter((e) => e.empty).length), "empty,",
        String(catalogue.entries.filter((e) => e.customisation).length), "customisations;",
        "the dossier ships", String(catalogue.shippedCountFromDossier)].join(" "));
      console.log(["wrote:", String(index.artefacts.length), "artefacts ->", out].join(" "));
      return 0;
    }
```

with `import { catalogueTemplates } from "./catalogue/templates";` at the top and the usage line widened to
`usage: bun run legacy <scope|profile|reconcile|templates> …`. In `packages/importer/src/index.ts`:

```ts
export { catalogueTemplates, classifyTemplate, templateStem, TEMPLATE_GROUP_RULES,
  type TemplateCatalogue, type TemplateEntry, type TemplateGroup } from "./catalogue/templates";
```

- [ ] **Step 6: Append to `tests/regression/legacy-077.test.ts` (create if absent)**

Contracts §3.7.3's **first corollary**: 9A has no fixed position in execution order, so it never "creates" — it
**appends, create-if-absent**, and its block asserts nothing about what other blocks exist. If the file is
already there (7A ran first), add only the `describe` below and touch nothing above it. If it is not, create
the file with exactly this content. The Part I heading is verbatim: "The call graph is unresolvable, so dead
code cannot be identified".

```ts
import { describe, expect, it } from "vitest";
import { catalogueTemplates, FixtureLegacyDriver, ReportWriter, type LegacyCorpus } from "@dulja/importer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LEGACY-077 The call graph is unresolvable, so dead code cannot be identified — 9A", () => {
  // A self-contained two-row corpus: packages/importer/test/support/corpus.ts is that package's own test
  // helper and is imported by no other workspace (plan header, §4.17.1 "none added").
  const corpus: LegacyCorpus = {
    engineVersion: "WI-V2.5.9.27139 Firebird 2.5",
    tables: {
      REPORTS: {
        keyColumns: ["ID"],
        columns: [
          { name: "ID", kind: "integer", scale: 0, nullable: false },
          { name: "NAME", kind: "text", scale: 0, nullable: true },
          { name: "DEFINITION", kind: "blob", scale: 0, nullable: true },
        ],
        rows: [
          { ID: "1", NAME: "AccMovement", DEFINITION: "VER1/+AAECAw" },
          { ID: "2", NAME: "AccMovementHorizontal", DEFINITION: "VER1/+AAECBA" },
        ],
      },
    },
  };

  it("makes the un-analysable blobs analysable: every definition comes out as a hashed file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-077-"));
    const writer = new ReportWriter(dir, { source: "regression corpus", engineVersion: "Firebird 2.5" });
    const catalogue = await catalogueTemplates(new FixtureLegacyDriver(corpus), writer);

    // The defect is that report definitions are opaque MEMO blobs inside the database, so nothing outside the
    // Dlux engine can see what exists or what duplicates what. Dulja's answer is not "parse the blob" — it is
    // "get every blob out of the database, name it, hash it, and say which names are near-duplicates".
    expect(catalogue.entries.map((e) => [e.name, e.bytes, e.file])).toEqual([
      ["AccMovement", 9, "templates/AccMovement.report"],
      ["AccMovementHorizontal", 9, "templates/AccMovementHorizontal.report"],
    ]);
    for (const entry of catalogue.entries) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.entries[0]?.nearDuplicateOf).toBe("AccMovementHorizontal");
    expect(catalogue.entries[1]?.nearDuplicateOf).toBe("AccMovement");
  });

  it("states that presence is not usage, so nobody reads a consolidation candidate as dead code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-077-"));
    const writer = new ReportWriter(dir, { source: "regression corpus", engineVersion: "Firebird 2.5" });
    const catalogue = await catalogueTemplates(new FixtureLegacyDriver(corpus), writer);
    expect(catalogue.note).toContain("not evidence it is used");
  });
});
```

`tests/package.json` gains one dependency so the workspace resolves the import — additive, and the only change
to that file:

```json
  "dependencies": { "@dulja/importer": "workspace:*" }
```

If the file already has a `dependencies` object, add the one key to it and change nothing else. The `tests`
workspace is outside every lint root (§3.7.5), so no rule is affected; `dependency-rule` governs
`packages/**` and `apps/**` and has no row for `tests`.

- [ ] **Step 7: Run everything and commit**

Run: `bun run --cwd packages/importer test && bun run --cwd tests test regression/legacy-077`
Expected: PASS in both. If `legacy-077.test.ts` already carried a 7A block, it still passes — nothing above the
new `describe` was touched.

Run: `bun run legacy templates --fixture base --out artefacts/legacy/dev`
Expected:

```
templates: 5 rows, 1 empty, 1 customisations; the dossier ships 255
wrote: 7 artefacts -> artefacts/legacy/dev
```

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green.

```
feat(importer): extract and catalogue the legacy report-definition blobs [9A T12]

§5.1 #9 / LEGACY-077 — the definitions live as MEMO blobs in the customer's database, so
this writes every one out byte-for-byte, hashes it, groups it by the dossier's §4.4
rules, and marks the near-duplicate families §7.10 names. The name, owner and blob
columns are discovered from the catalogue, never assumed. Correction C2 carries a blob
across the driver seam as base64 instead of a lossy String(buffer). Appends the 9A
block to tests/regression/legacy-077.test.ts, create-if-absent (§3.7.3).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 13: OWNER GATE OD-27 — the open-question probe (Part VII #6, #7, #8, #9, #13)

> **This task is isolated (contracts §2.0, §2.12, hazard 6).** OD-27 is five spec questions in one ledger row:
> **#6** real DDL constraints (spec:2470), **#7** does `MatOpens.Job` ever differ from 0 (spec:2471), **#8**
> which of the 255 report templates are in use (spec:2472), **#9** the `Special`/`rah*`/`spr*` customisations
> (spec:2473), **#13** is the legacy `Salaries` module in live use (spec:2477). The §2.12 default is **none** —
> no answer exists — and the ledger's gate column says "9A → profiler outputs". This task ships the probe that
> *produces* the evidence for all five. Drop the task and the five questions simply stay unanswered; nothing
> else in this plan depends on it.
>
> **Owner provides (OD-27):** read access to the live database (this is OD-17's access, used again) and then
> the **answers**, informed by this probe's artefact. Nothing else. The probe needs no credential the scoping
> run did not already need.
>
> **Verify:** `bun run legacy questions --dsn "$LEGACY_ODBC_DSN" --out artefacts/legacy/questions` prints five
> lines, one per question, each ending `verdict: owner (OD-27)`, and writes `open-questions.json` +
> `open-questions.csv`.
>
> **Until answered:** `bun run legacy questions --fixture questions` runs against the committed corpus and
> prints the same five lines with the corpus's own numbers. Every `verdict` field in the artefact is `null` and
> the `status` of a question the source cannot answer is `unanswerable_here` — never a guess. **This plan
> decides none of the five** (hazard 7): it reports evidence and names the decision as the owner's.

**Files:**
- Create: `packages/importer/src/catalogue/questions.ts`, `packages/importer/test/corpus/questions/catalog.json`, `packages/importer/test/corpus/questions/{ACCOUNTS,MATOPENS,MATUNITS,MATOBJECTS,EMPLOYEES,PAYROLLS,PAYITEMS,TAXLAYERS,SPRORDERS,REPORTS}.json`
- Modify: `packages/importer/src/legacy/types.ts` (`LegacyConstraint`, `LegacyDriver.constraints`), `packages/importer/src/drivers/fixture.ts`, `packages/importer/src/drivers/odbc.ts`, `packages/importer/test/support/corpus.ts`, `packages/importer/src/cli.ts` (the `questions` command), `packages/importer/src/index.ts` (**Step 6** — one line, `type LegacyConstraint`; the questions group stays 9A-internal)
- Test: `packages/importer/test/questions.test.ts`

**Interfaces:**
- Consumes: `LegacyReader` (T4), `LegacyDriver`/`LegacyColumn` (T1), `classifyTemplate` (T12), `ALL_LEGACY_TABLES`/`moduleOf` (T1), `ReportWriter` (T5).
- Produces:
  ```ts
  // packages/importer/src/legacy/types.ts — added to the port, implemented by both drivers
  export interface LegacyConstraint {
    readonly table: string;
    readonly name: string;
    readonly kind: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK" | "other";
    readonly columns: readonly string[];
    readonly referencedTable: string | null;
  }
  // added to the LegacyDriver interface, on its own line directly after `keyColumns`:
  //   constraints(table: string): Promise<LegacyConstraint[]>;

  // packages/importer/src/catalogue/questions.ts
  export type QuestionId = "VII-6" | "VII-7" | "VII-8" | "VII-9" | "VII-13";
  export type QuestionStatus = "evidence_collected" | "unanswerable_here";
  export interface OpenQuestionAnswer {
    readonly id: QuestionId;
    readonly question: string;                       // spec verbatim
    readonly specLine: number;
    readonly status: QuestionStatus;
    readonly evidence: readonly Record<string, string>[];
    readonly finding: string;
    readonly ownerDecision: "OD-27";
    readonly verdict: null;                          // this plan decides nothing
  }
  export interface OpenQuestionReport {
    readonly generatedAt: string;
    readonly source: string;
    readonly engineVersion: string;
    readonly answers: readonly OpenQuestionAnswer[];
  }
  export interface ConstraintClaim {
    readonly legacyDefect: string;
    readonly table: string;
    readonly columns: readonly string[];
    readonly claim: string;
    readonly confirmedBy: "absent_unique" | "declared_type" | "absent_primary_key" | "code_shape";
  }
  export const CONSTRAINT_CLAIMS: readonly ConstraintClaim[];
  export const SALARIES_LIVENESS_TABLES: readonly string[];
  export async function answerOpenQuestions(reader: LegacyReader, driver: LegacyDriver): Promise<OpenQuestionReport>;
  ```

**Why a probe and not a claim.** Part VII #6, verbatim (spec:2470): "**Actual DDL constraints.** Several
findings (LEGACY-024, 049, 051, 066, 074) rest on the schema dump's key convention rather than real DDL. Confirm
against `RDB$RELATION_CONSTRAINTS` and `RDB$INDICES` before rating them." That sentence is an instruction to
this task and to nothing else in the project: contracts §3.7.3 has 1A create `tests/regression/legacy-024.test.ts`
**marked `it.skip` with the reason until OD-27 answers Part VII #6**, and this probe is what produces that
answer. Each of the five defects becomes one row of `CONSTRAINT_CLAIMS` naming the table, the columns and what
would confirm it — so the artefact reads as "here is the claim, here is what the engine actually declares",
and the rating stays the owner's and the architect's call.

- [ ] **Step 1: Add `constraints` to the port and to both drivers**

In `packages/importer/src/legacy/types.ts`, after `LegacyColumn`:

```ts
/**
 * A real constraint, as the engine declares it — not as the schema dump's naming convention implies. Part VII
 * #6 (spec:2470) exists because five Part I findings rest on the convention: LEGACY-024, 049, 051, 066 and 074.
 */
export interface LegacyConstraint {
  readonly table: string;
  readonly name: string;
  readonly kind: "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE" | "CHECK" | "other";
  readonly columns: readonly string[];
  readonly referencedTable: string | null;
}
```

and one line inside `LegacyDriver`, directly after `keyColumns`:

```ts
  constraints(table: string): Promise<LegacyConstraint[]>;
```

In `packages/importer/src/drivers/fixture.ts`, widen `LegacyCorpus`'s per-table shape with an optional member
and implement the method:

```ts
// inside LegacyCorpus.tables[table]:
    readonly constraints?: readonly LegacyConstraint[];
```

```ts
  /**
   * Declared constraints, plus a synthesised PRIMARY KEY when the corpus gives key columns and declares no
   * PRIMARY KEY. The synthesis is what keeps the two drivers agreeing: `OdbcLegacyDriver.keyColumns` *derives*
   * its answer from `RDB$RELATION_CONSTRAINTS`, so on a live source a table with key columns necessarily has
   * a PRIMARY KEY constraint. Without this, a corpus table with `keyColumns` and no `constraints` entry would
   * report "no key declared" here and "PRIMARY KEY" there, and Task 13's report would read differently
   * against the fixture than against the database it exists to describe.
   */
  constraints(table: string): Promise<LegacyConstraint[]> {
    const entry = this.corpus.tables[table];
    if (!entry) throw unreadable(`table ${table} is not in this corpus`);
    const declared = [...(entry.constraints ?? [])];
    if (entry.keyColumns.length > 0 && !declared.some((c) => c.kind === "PRIMARY KEY")) {
      declared.unshift({ table, name: ["PK_", table].join(""), kind: "PRIMARY KEY", columns: [...entry.keyColumns], referencedTable: null });
    }
    return Promise.resolve(declared);
  }
```

and add `LegacyConstraint` to that file's existing type-only import from `../legacy/types`.

In `packages/importer/src/drivers/odbc.ts`, beside `keyColumns` — one statement, one literal, no interpolation:

```ts
  async constraints(table: string): Promise<LegacyConstraint[]> {
    const rows = await this.conn.query(
      `select trim(c.rdb$constraint_name) as "CN", trim(c.rdb$constraint_type) as "CT", trim(s.rdb$field_name) as "FN", trim(coalesce(r2.rdb$relation_name, '')) as "RT" from rdb$relation_constraints c left join rdb$index_segments s on s.rdb$index_name = c.rdb$index_name left join rdb$ref_constraints rc on rc.rdb$constraint_name = c.rdb$constraint_name left join rdb$relation_constraints r2 on r2.rdb$constraint_name = rc.rdb$const_name_uq where c.rdb$relation_name = ? order by c.rdb$constraint_name, s.rdb$field_position`,
      [table],
    );
    const grouped = new Map<string, { kind: string; columns: string[]; referenced: string }>();
    for (const row of rows) {
      const name = String(row.CN ?? "");
      const existing = grouped.get(name) ?? { kind: String(row.CT ?? ""), columns: [], referenced: String(row.RT ?? "") };
      const column = row.FN === null || row.FN === undefined ? "" : String(row.FN);
      if (column.length > 0) existing.columns.push(column);
      grouped.set(name, existing);
    }
    return [...grouped].map(([name, g]) => ({
      table, name,
      kind: KNOWN_CONSTRAINT_KINDS.includes(g.kind as LegacyConstraint["kind"]) ? (g.kind as LegacyConstraint["kind"]) : "other",
      columns: g.columns,
      referencedTable: g.referenced.length > 0 ? g.referenced : null,
    }));
  }
```

with, at module scope in the same file:

```ts
const KNOWN_CONSTRAINT_KINDS: readonly LegacyConstraint["kind"][] = ["PRIMARY KEY", "FOREIGN KEY", "UNIQUE", "CHECK"];
```

and `LegacyConstraint` added to that file's existing type-only import from `../legacy/types`. **Note on the
statement:** it is one unbroken template literal with no interpolation, which is the shape Task 3 Step 3
already established for `tables`, `columns` and `keyColumns` and the reason it gave — spec:100 forbids
building SQL by string concatenation, and a `+` join whose operands are both literals is still that shape.
Do not split this line to make it shorter.

In `packages/importer/test/support/corpus.ts`, carry the new optional member through `loadCorpus` — two edits,
both additive:

```ts
interface CatalogFile {
  engineVersion: string | null;
  tables: Record<string, { keyColumns: string[]; columns: LegacyColumn[]; constraints?: LegacyConstraint[] }>;
}
```

```ts
    tables[table] = {
      columns: meta.columns,
      keyColumns: meta.keyColumns,
      constraints: meta.constraints ?? [],
      rows: JSON.parse(readFileSync(join(dir, `${table}.json`), "utf8")) as LegacyRow[],
    };
```

with `LegacyConstraint` added to the type-only import. The identical two-line change goes into `openDriver`'s
inline catalogue reader in `packages/importer/src/cli.ts`, which duplicates this shape.

- [ ] **Step 2: Write the `questions` corpus**

`packages/importer/test/corpus/questions/catalog.json` — ten tables, and deliberately only *one explicitly*
declared constraint in the whole file, because "the aggregate tables have no unique key" is the thing under
test. The other tables' primary keys come from `keyColumns` through the synthesis in Step 1, and `MATOBJECTS`
has `keyColumns: []`, so it genuinely declares nothing:

```json
{
  "engineVersion": "WI-V2.5.9.27139 Firebird 2.5",
  "tables": {
    "ACCOUNTS": {
      "keyColumns": ["SITE", "ID"],
      "constraints": [
        { "table": "ACCOUNTS", "name": "PK_ACCOUNTS", "kind": "PRIMARY KEY", "columns": ["SITE", "ID"], "referencedTable": null }
      ],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "CODE", "kind": "text", "scale": 0, "nullable": true },
        { "name": "PARENT", "kind": "integer", "scale": 0, "nullable": true }
      ]
    },
    "MATOPENS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "JOB", "kind": "integer", "scale": 0, "nullable": true },
        { "name": "QUANTITY", "kind": "decimal", "scale": 4, "nullable": true }
      ]
    },
    "MATUNITS": {
      "keyColumns": ["SITE", "ID", "UNIT"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "UNIT", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "EXCHANGE", "kind": "float", "scale": 0, "nullable": true }
      ]
    },
    "MATOBJECTS": {
      "keyColumns": [],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "QUANTITY", "kind": "decimal", "scale": 4, "nullable": true }
      ]
    },
    "EMPLOYEES": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "NAME", "kind": "text", "scale": 0, "nullable": true }
      ]
    },
    "PAYROLLS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "DATE", "kind": "date", "scale": 0, "nullable": true }
      ]
    },
    "PAYITEMS": {
      "keyColumns": ["SITE", "ID", "ROW"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ROW", "kind": "integer", "scale": 0, "nullable": false }
      ]
    },
    "TAXLAYERS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false }
      ]
    },
    "SPRORDERS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false }
      ]
    },
    "REPORTS": {
      "keyColumns": ["SITE", "ID"],
      "columns": [
        { "name": "SITE", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "ID", "kind": "integer", "scale": 0, "nullable": false },
        { "name": "NAME", "kind": "text", "scale": 0, "nullable": true },
        { "name": "USERNAME", "kind": "text", "scale": 0, "nullable": true },
        { "name": "DEFINITION", "kind": "blob", "scale": 0, "nullable": true }
      ]
    }
  }
}
```

The ten row files:

```json
[
  { "SITE": "1", "ID": "10", "CODE": "1", "PARENT": "0" },
  { "SITE": "1", "ID": "11", "CODE": "9", "PARENT": "0" },
  { "SITE": "1", "ID": "12", "CODE": "10", "PARENT": "0" }
]
```
— `ACCOUNTS.json`. Three sibling codes `1`, `9`, `10` under one parent: exactly the shape LEGACY-024 describes,
where `max()` on a string returns `'9'` and the next allocation collides. They are **not** zero-padded, which
is the evidence that the external `IncCodeNumber` UDF does not pad here.

```json
[
  { "SITE": "1", "ID": "1", "JOB": "0", "QUANTITY": "5.0000" },
  { "SITE": "1", "ID": "2", "JOB": "7", "QUANTITY": "3.0000" }
]
```
— `MATOPENS.json`. One row with `JOB <> 0`, so Part VII #7's answer in this corpus is "yes, and LEGACY-022 is a
hard failure".

```json
[{ "SITE": "1", "ID": "1", "UNIT": "2", "EXCHANGE": "12.5" }]
```
— `MATUNITS.json`.

```json
[
  { "SITE": "1", "ID": "1", "QUANTITY": "5.0000" },
  { "SITE": "1", "ID": "1", "QUANTITY": "5.0000" }
]
```
— `MATOBJECTS.json`: no key columns, and the same natural key twice.

```json
[{ "SITE": "1", "ID": "5", "NAME": "Ali Hassan" }]
```
— `EMPLOYEES.json`.

```json
[{ "SITE": "1", "ID": "1", "DATE": "2024-06-30" }]
```
— `PAYROLLS.json`.

```json
[{ "SITE": "1", "ID": "1", "ROW": "1" }]
```
— `PAYITEMS.json`.

`TAXLAYERS.json` and `SPRORDERS.json` are both `[]` — an empty file is an answer, and for `SPRORDERS` it is
"this customisation ships but is unused".

```json
[
  { "SITE": "1", "ID": "1", "NAME": "AccMovement", "USERNAME": "SYSDBA", "DEFINITION": "VER1/+AAECAw" },
  { "SITE": "1", "ID": "2", "NAME": "sprAccTargets", "USERNAME": "ahmad", "DEFINITION": "VER1/+AAECBg" },
  { "SITE": "1", "ID": "3", "NAME": "MatBalances", "USERNAME": null, "DEFINITION": null }
]
```
— `REPORTS.json`.

- [ ] **Step 3: Write the failing test**

`packages/importer/test/questions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { answerOpenQuestions, CONSTRAINT_CLAIMS, SALARIES_LIVENESS_TABLES } from "../src/catalogue/questions";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { createReader } from "../src/reader";
import { loadCorpus } from "./support/corpus";

const report = async () => {
  const driver = new FixtureLegacyDriver(loadCorpus("questions"), "questions corpus");
  return answerOpenQuestions(await createReader(driver), driver);
};

describe("answerOpenQuestions — OD-27, and it decides nothing", () => {
  it("answers all five questions and no others, in spec order", async () => {
    const r = await report();
    expect(r.answers.map((a) => a.id)).toEqual(["VII-6", "VII-7", "VII-8", "VII-9", "VII-13"]);
    expect(r.answers.map((a) => a.specLine)).toEqual([2470, 2471, 2472, 2473, 2477]);
  });

  it("leaves every verdict null and names the owner decision on every answer (hazard 7)", async () => {
    for (const answer of (await report()).answers) {
      expect(answer.verdict).toBeNull();
      expect(answer.ownerDecision).toBe("OD-27");
    }
  });

  it("#6 reports what the engine declares against each of the five claims", async () => {
    const six = (await report()).answers.find((a) => a.id === "VII-6");
    expect(six?.status).toBe("evidence_collected");
    expect(six?.evidence).toEqual([
      { legacyDefect: "LEGACY-024", table: "ACCOUNTS", columns: "CODE", declared: "PRIMARY KEY(SITE,ID)",
        finding: "no UNIQUE on CODE; 1 sibling groups contain codes a lexicographic max() would mis-order; codes are not zero-padded",
        claim: "Account codes are allocated with max() on a string, without locking (spec:425)" },
      { legacyDefect: "LEGACY-049", table: "MATOBJECTS", columns: "SITE,ID", declared: "none",
        finding: "no PRIMARY KEY and no UNIQUE; 1 natural key occurs more than once",
        claim: "Aggregate tables have no unique key, so the upsert race creates duplicates (spec:630)" },
      { legacyDefect: "LEGACY-051", table: "BILLS", columns: "NUMBER", declared: "table absent from this source",
        finding: "cannot be checked here", claim: "Document numbering has no uniqueness constraint (spec:647)" },
      { legacyDefect: "LEGACY-066", table: "MATUNITS", columns: "EXCHANGE", declared: "PRIMARY KEY(SITE,ID,UNIT)",
        finding: "EXCHANGE is declared float", claim: "Unit conversion is defined in the schema and applied nowhere (spec:736)" },
      // "declare", not "declares": the sentence is built from a count that is usually greater than one, and
      // `sixDdlConstraints` uses the one word rather than pluralising a verb in two places.
      { legacyDefect: "LEGACY-074", table: "*", columns: "", declared: "10 tables read",
        finding: "1 of 10 tables declare no PRIMARY KEY: MATOBJECTS",
        claim: "42 of 460 tables have no primary key (spec:831)" },
    ]);
  });

  it("#7 quantifies MatOpens.Job rather than asserting LEGACY-022", async () => {
    const seven = (await report()).answers.find((a) => a.id === "VII-7");
    expect(seven?.evidence).toEqual([{ table: "MATOPENS", rows: "2", jobNonZero: "1", distinctJobs: "1" }]);
    expect(seven?.finding).toBe(
      "MatOpens.Job differs from 0 on 1 of 2 rows, so LEGACY-022's singleton SELECT ... INTO is a hard failure on this data, not inert.",
    );
  });

  it("#8 reports template evidence and refuses to call presence usage", async () => {
    const eight = (await report()).answers.find((a) => a.id === "VII-8");
    expect(eight?.evidence).toEqual([
      { table: "REPORTS", rows: "3", withDefinition: "2", empty: "1", distinctOwners: "2", customisations: "1" },
    ]);
    expect(eight?.finding).toContain("presence is not usage");
  });

  it("#9 counts every Special-module table and the customisation templates", async () => {
    const nine = (await report()).answers.find((a) => a.id === "VII-9");
    expect(nine?.evidence).toEqual([
      { source: "Special module tables", present: "1", withRows: "0", detail: "SPRORDERS=0" },
      { source: "customisation report templates", present: "1", withRows: "1", detail: "sprAccTargets" },
    ]);
  });

  it("#13 counts the five tables the spec names, and says LENDS is not in the shipped map", async () => {
    const thirteen = (await report()).answers.find((a) => a.id === "VII-13");
    expect(SALARIES_LIVENESS_TABLES).toEqual(["EMPLOYEES", "PAYROLLS", "PAYITEMS", "LENDS", "TAXLAYERS"]);
    expect(thirteen?.evidence).toEqual([
      { table: "EMPLOYEES", rows: "1", note: "" },
      { table: "PAYROLLS", rows: "1", note: "" },
      { table: "PAYITEMS", rows: "1", note: "" },
      { table: "LENDS", rows: "", note: "absent from this source and from the 460-table shipped map; the dossier names it in prose only (analysis §4.5)" },
      { table: "TAXLAYERS", rows: "0", note: "" },
    ]);
    expect(thirteen?.finding).toBe(
      "The Salaries module has rows in 3 of the 5 tables the spec names, so it is in live use; §5.1 #11's default stands — 9B imports the employee master and current-tax-year YTD and never TaxLayers.",
    );
  });

  it("declares one claim per Part VII #6 defect and no more", () => {
    expect(CONSTRAINT_CLAIMS.map((c) => c.legacyDefect)).toEqual(["LEGACY-024", "LEGACY-049", "LEGACY-051", "LEGACY-066", "LEGACY-074"]);
  });
});
```

- [ ] **Step 4: Run it and see it fail**

Run: `bun run --cwd packages/importer test questions`
Expected: FAIL — `Cannot find module '../src/catalogue/questions'`.

- [ ] **Step 5: Write `packages/importer/src/catalogue/questions.ts`**

```ts
import { classifyTemplate } from "./templates";
import { ALL_LEGACY_TABLES, LEGACY_MODULES } from "../legacy/modules";
import type { LegacyDriver } from "../legacy/types";
import type { LegacyReader } from "../reader";

export type QuestionId = "VII-6" | "VII-7" | "VII-8" | "VII-9" | "VII-13";
export type QuestionStatus = "evidence_collected" | "unanswerable_here";

export interface OpenQuestionAnswer {
  readonly id: QuestionId;
  readonly question: string;
  readonly specLine: number;
  readonly status: QuestionStatus;
  readonly evidence: readonly Record<string, string>[];
  readonly finding: string;
  readonly ownerDecision: "OD-27";
  readonly verdict: null;
}

export interface OpenQuestionReport {
  readonly generatedAt: string;
  readonly source: string;
  readonly engineVersion: string;
  readonly answers: readonly OpenQuestionAnswer[];
}

export interface ConstraintClaim {
  readonly legacyDefect: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly claim: string;
  readonly confirmedBy: "absent_unique" | "declared_type" | "absent_primary_key" | "code_shape";
}

/**
 * Part VII #6, verbatim (spec:2470): "Several findings (LEGACY-024, 049, 051, 066, 074) rest on the schema dump's
 * key convention rather than real DDL. Confirm against RDB$RELATION_CONSTRAINTS and RDB$INDICES before rating
 * them." One row per named defect, in the spec's own order. `confirmedBy` says what would confirm the claim,
 * so the artefact is falsifiable rather than rhetorical.
 */
export const CONSTRAINT_CLAIMS: readonly ConstraintClaim[] = [
  { legacyDefect: "LEGACY-024", table: "ACCOUNTS", columns: ["CODE"], confirmedBy: "code_shape",
    claim: "Account codes are allocated with max() on a string, without locking (spec:425)" },
  { legacyDefect: "LEGACY-049", table: "MATOBJECTS", columns: ["SITE", "ID"], confirmedBy: "absent_unique",
    claim: "Aggregate tables have no unique key, so the upsert race creates duplicates (spec:630)" },
  { legacyDefect: "LEGACY-051", table: "BILLS", columns: ["NUMBER"], confirmedBy: "absent_unique",
    claim: "Document numbering has no uniqueness constraint (spec:647)" },
  { legacyDefect: "LEGACY-066", table: "MATUNITS", columns: ["EXCHANGE"], confirmedBy: "declared_type",
    claim: "Unit conversion is defined in the schema and applied nowhere (spec:736)" },
  { legacyDefect: "LEGACY-074", table: "*", columns: [], confirmedBy: "absent_primary_key",
    claim: "42 of 460 tables have no primary key (spec:831)" },
];

/**
 * Part VII #13, verbatim (spec:2477): "Row counts on `Employees`, `Payrolls`, `PayItems`, `Lends`,
 * `TaxLayers`." The five names are the spec's, in the spec's order. **`LENDS` is deliberately not in
 * `LEGACY_MODULES`' Salaries list**: the dossier's Appendix A inventory of 36 Salaries tables does not contain
 * it and the per-module totals that sum to 460 depend on that list being exactly the inventory. It appears
 * only in the dossier's prose ("advances (`Lends` in UI units)", analysis §4.5). The probe therefore reports
 * it as absent from the map rather than counting it, and **no task adds it to the 460** — Task 1 Step 4's
 * `ALL_LEGACY_TABLES.size === 460` assertion is the reason and stays untouched.
 */
export const SALARIES_LIVENESS_TABLES: readonly string[] = ["EMPLOYEES", "PAYROLLS", "PAYITEMS", "LENDS", "TAXLAYERS"];

const QUESTIONS: Readonly<Record<QuestionId, { line: number; text: string }>> = {
  "VII-6": { line: 2470, text: "Actual DDL constraints. Several findings (LEGACY-024, 049, 051, 066, 074) rest on the schema dump's key convention rather than real DDL. Confirm against RDB$RELATION_CONSTRAINTS and RDB$INDICES before rating them." },
  "VII-7": { line: 2471, text: "Does MatOpens.Job ever differ from 0 in production? LEGACY-022 is a hard failure if so, and inert if not." },
  "VII-8": { line: 2472, text: "Which of the 255 report templates are in use? They live as blobs in the customer database; extract and catalogue them." },
  "VII-9": { line: 2473, text: "Customisations. The Special, rah* and spr* modules are customer-specific. Catalogue them before assuming the stock feature set." },
  "VII-13": { line: 2477, text: "Is the legacy Salaries module in live use? Row counts on Employees, Payrolls, PayItems, Lends, TaxLayers. Determines whether Phase 9 imports only the employee master and current-year YTD (the default) or also historical payroll detail for viewing." },
};

export async function answerOpenQuestions(reader: LegacyReader, driver: LegacyDriver): Promise<OpenQuestionReport> {
  const present = new Set(await reader.tables());
  const answers: OpenQuestionAnswer[] = [
    await sixDdlConstraints(reader, driver, present),
    await sevenMatOpensJob(reader, present),
    await eightTemplates(reader, present),
    await nineCustomisations(reader, present),
    await thirteenSalaries(reader, present),
  ];
  return {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: driver.source, engineVersion: reader.firebirdVersion, answers,
  };
}

const answer = (id: QuestionId, evidence: Record<string, string>[], finding: string, status: QuestionStatus = "evidence_collected"): OpenQuestionAnswer => ({
  id, question: QUESTIONS[id].text, specLine: QUESTIONS[id].line, status, evidence, finding,
  ownerDecision: "OD-27", verdict: null,
});

const declaredOf = (constraints: readonly { kind: string; columns: readonly string[] }[]): string => {
  const parts = constraints
    .filter((c) => c.kind === "PRIMARY KEY" || c.kind === "UNIQUE")
    .map((c) => [c.kind, "(", c.columns.join(","), ")"].join(""));
  return parts.length > 0 ? parts.join(" ") : "none";
};

async function sixDdlConstraints(
  reader: LegacyReader, driver: LegacyDriver, present: ReadonlySet<string>,
): Promise<OpenQuestionAnswer> {
  const evidence: Record<string, string>[] = [];
  for (const claim of CONSTRAINT_CLAIMS) {
    const base = { legacyDefect: claim.legacyDefect, table: claim.table, columns: claim.columns.join(","), claim: claim.claim };

    if (claim.confirmedBy === "absent_primary_key") {
      const tables = [...present].sort();
      const without: string[] = [];
      for (const table of tables) if ((await driver.keyColumns(table)).length === 0) without.push(table);
      evidence.push({ ...base, declared: [String(tables.length), "tables read"].join(" "),
        finding: [String(without.length), "of", String(tables.length), "tables declare no PRIMARY KEY:", without.join(", ") || "(none)"].join(" ") });
      continue;
    }
    if (!present.has(claim.table)) {
      evidence.push({ ...base, declared: "table absent from this source", finding: "cannot be checked here" });
      continue;
    }
    const constraints = await driver.constraints(claim.table);
    const declared = declaredOf(constraints);
    const columns = await driver.columns(claim.table);

    // A source that has the table but not the column is the common case, not an error: this probe runs against
    // whatever the customer's database holds, and the synthetic base corpus holds ACCOUNTS without PARENT.
    // Reading a column the catalogue does not declare would raise ERR_IMPORT_SOURCE_UNREADABLE out of
    // quoteIdent and abort the whole `legacy all` run over one unanswerable claim, so it is checked first.
    const names = new Set(columns.map((c) => c.name));
    const needed = claim.confirmedBy === "code_shape" ? ["PARENT", ...claim.columns] : [...claim.columns];
    const missing = needed.filter((c) => !names.has(c));
    if (missing.length > 0) {
      evidence.push({ ...base, declared,
        finding: ["column", missing.join(", "), missing.length === 1 ? "is" : "are", "not declared on this table; cannot be checked here"].join(" ") });
      continue;
    }

    if (claim.confirmedBy === "declared_type") {
      const column = columns.find((c) => c.name === claim.columns[0]);
      evidence.push({ ...base, declared, finding: [claim.columns[0], "is declared", column?.kind ?? "unknown"].join(" ") });
      continue;
    }
    if (claim.confirmedBy === "code_shape") {
      const siblings = new Map<string, string[]>();
      for await (const batch of reader.read<Record<string, string | boolean | null>>(claim.table, { columns: ["PARENT", "CODE"], batch: 500 })) {
        for (const row of batch) {
          const parent = String(row.PARENT ?? "");
          siblings.set(parent, [...(siblings.get(parent) ?? []), String(row.CODE ?? "")]);
        }
      }
      let misordered = 0;
      let padded = true;
      for (const codes of siblings.values()) {
        const widths = new Set(codes.map((c) => c.length));
        if (widths.size > 1) misordered += 1;
        if (widths.size > 1) padded = false;
      }
      const unique = constraints.some((c) => c.kind === "UNIQUE" && c.columns.includes("CODE"));
      evidence.push({ ...base, declared,
        finding: [unique ? "UNIQUE on CODE is declared" : "no UNIQUE on CODE", ";",
          String(misordered), "sibling groups contain codes a lexicographic max() would mis-order; codes are",
          padded ? "zero-padded" : "not zero-padded"].join(" ").replace(" ; ", "; ") });
      continue;
    }
    const keyed = constraints.some((c) => c.kind === "PRIMARY KEY" || c.kind === "UNIQUE");
    const seen = new Map<string, number>();
    for await (const batch of reader.read<Record<string, string | boolean | null>>(claim.table, { columns: [...claim.columns], batch: 500 })) {
      for (const row of batch) {
        const key = claim.columns.map((c) => String(row[c] ?? "")).join("");
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    const duplicated = [...seen.values()].filter((n) => n > 1).length;
    evidence.push({ ...base, declared,
      finding: [keyed ? "a PRIMARY KEY or UNIQUE is declared" : "no PRIMARY KEY and no UNIQUE", ";",
        String(duplicated), "natural key" + (duplicated === 1 ? "" : "s"), duplicated === 1 ? "occurs" : "occur",
        "more than once"].join(" ").replace(" ; ", "; ") });
  }
  return answer("VII-6", evidence,
    "Each claim is reported against what the engine declares. Rating LEGACY-024, 049, 051, 066 and 074 — and un-skipping tests/regression/legacy-024.test.ts, which 1A created marked it.skip pending this answer (contracts §3.7.3) — is the owner's and the architect's call, not this report's.");
}

async function sevenMatOpensJob(reader: LegacyReader, present: ReadonlySet<string>): Promise<OpenQuestionAnswer> {
  if (!present.has("MATOPENS")) {
    return answer("VII-7", [{ table: "MATOPENS", rows: "", jobNonZero: "", distinctJobs: "" }],
      "MATOPENS is absent from this source, so the question cannot be answered here.", "unanswerable_here");
  }
  const rows = await reader.count("MATOPENS");
  const jobs = new Map<string, number>();
  for await (const batch of reader.read<Record<string, string | boolean | null>>("MATOPENS", { columns: ["JOB"], batch: 1000 })) {
    for (const row of batch) {
      const job = row.JOB === null || row.JOB === undefined ? "" : String(row.JOB);
      if (job === "" || job === "0") continue;
      jobs.set(job, (jobs.get(job) ?? 0) + 1);
    }
  }
  const nonZero = [...jobs.values()].reduce((a, b) => a + b, 0);
  return answer("VII-7",
    [{ table: "MATOPENS", rows: String(rows), jobNonZero: String(nonZero), distinctJobs: String(jobs.size) }],
    nonZero > 0
      ? ["MatOpens.Job differs from 0 on", String(nonZero), "of", String(rows),
         "rows, so LEGACY-022's singleton SELECT ... INTO is a hard failure on this data, not inert."].join(" ")
      : ["MatOpens.Job is 0 or null on all", String(rows),
         "rows, so LEGACY-022 is inert on this data — which rates the defect and does not remove it from the new design."].join(" "));
}

async function eightTemplates(reader: LegacyReader, present: ReadonlySet<string>): Promise<OpenQuestionAnswer> {
  if (!present.has("REPORTS")) {
    return answer("VII-8", [], "REPORTS is absent from this source, so no template evidence exists here.", "unanswerable_here");
  }
  const rows = await reader.count("REPORTS");
  let withDefinition = 0;
  let customisations = 0;
  const owners = new Set<string>();
  for await (const batch of reader.read<Record<string, string | boolean | null>>("REPORTS", { columns: ["NAME", "USERNAME", "DEFINITION"], batch: 200 })) {
    for (const row of batch) {
      const definition = row.DEFINITION;
      if (typeof definition === "string" && definition.length > 0) withDefinition += 1;
      if (row.USERNAME !== null && row.USERNAME !== undefined) owners.add(String(row.USERNAME));
      if (classifyTemplate(String(row.NAME ?? "")).customisation) customisations += 1;
    }
  }
  return answer("VII-8",
    [{ table: "REPORTS", rows: String(rows), withDefinition: String(withDefinition),
       empty: String(rows - withDefinition), distinctOwners: String(owners.size), customisations: String(customisations) }],
    "These are the definitions stored in this database; presence is not usage, and nothing here says a template was ever run. Run `legacy templates` for the per-template catalogue with hashes and the near-duplicate families.");
}

async function nineCustomisations(reader: LegacyReader, present: ReadonlySet<string>): Promise<OpenQuestionAnswer> {
  const special = LEGACY_MODULES.find((m) => m.id === "special");
  const tables = (special?.tables ?? []).filter((t) => present.has(t));
  const counts: string[] = [];
  let withRows = 0;
  for (const table of tables) {
    const rows = await reader.count(table);
    if (rows > 0) withRows += 1;
    counts.push([table, String(rows)].join("="));
  }
  const templates: string[] = [];
  if (present.has("REPORTS")) {
    for await (const batch of reader.read<Record<string, string | boolean | null>>("REPORTS", { columns: ["NAME"], batch: 200 })) {
      for (const row of batch) {
        const name = String(row.NAME ?? "");
        if (classifyTemplate(name).customisation) templates.push(name);
      }
    }
  }
  return answer("VII-9", [
    { source: "Special module tables", present: String(tables.length), withRows: String(withRows), detail: counts.join(" ") },
    { source: "customisation report templates", present: String(templates.length),
      withRows: String(templates.length), detail: templates.join(" ") },
  ],
    "The Special module's tables and the spr*/rah*/dnt*/med* templates are the customer-specific surface (analysis §7.11). A table that ships with no rows is dead weight this rebuild need not carry; that judgement is the owner's.");
}

async function thirteenSalaries(reader: LegacyReader, present: ReadonlySet<string>): Promise<OpenQuestionAnswer> {
  const evidence: Record<string, string>[] = [];
  let live = 0;
  for (const table of SALARIES_LIVENESS_TABLES) {
    if (!present.has(table)) {
      evidence.push({ table, rows: "",
        note: ALL_LEGACY_TABLES.has(table)
          ? "absent from this source but present in the 460-table shipped map"
          : "absent from this source and from the 460-table shipped map; the dossier names it in prose only (analysis §4.5)" });
      continue;
    }
    const rows = await reader.count(table);
    if (rows > 0) live += 1;
    evidence.push({ table, rows: String(rows), note: "" });
  }
  return answer("VII-13", evidence,
    live > 0
      ? ["The Salaries module has rows in", String(live), "of the", String(SALARIES_LIVENESS_TABLES.length),
         "tables the spec names, so it is in live use; §5.1 #11's default stands — 9B imports the employee master and current-tax-year YTD and never TaxLayers."].join(" ")
      : ["No table the spec names has a row, so the Salaries module is not in live use here; 9B's employee and YTD loaders have nothing to read and Phase 8 starts from an empty employee master."].join(" "));
}
```

- [ ] **Step 6: Add the `questions` command and the export**

In `packages/importer/src/cli.ts`, a branch beside `templates`:

```ts
    if (args.command === "questions") {
      const reader = await createReader(driver, args.flags["firebird-version"]);
      const report = await answerOpenQuestions(reader, driver);
      const writer = new ReportWriter(out, { source: driver.source, engineVersion: reader.firebirdVersion });
      writer.json("open-questions.json", report, report.answers.length);
      writer.csv("open-questions.csv", report.answers.flatMap((a) =>
        a.evidence.map((e) => ({ id: a.id, spec_line: a.specLine, status: a.status, finding: a.finding, ...e }))));
      const index = writer.finish();
      for (const a of report.answers) {
        console.log([a.id, a.status, "—", a.finding, "verdict: owner (OD-27)"].join(" "));
      }
      console.log(["wrote:", index.artefacts.map((x) => x.name).join(", "), "->", out].join(" "));
      return 0;
    }
```

with `import { answerOpenQuestions } from "./catalogue/questions";` and the usage line widened to
`usage: bun run legacy <scope|profile|reconcile|templates|questions> …`. In `packages/importer/src/index.ts`,
**one line, and it is the last line this plan adds to the barrel**:

```ts
export type { LegacyConstraint } from "./legacy/types";
```

`LegacyConstraint` is on §4.13.1's barrel list (beside `LegacyColumn`, `LegacyDriver` and `SelectSpec`), so it
crosses. **The questions group does not** — `answerOpenQuestions`, `CONSTRAINT_CLAIMS`,
`SALARIES_LIVENESS_TABLES`, `ConstraintClaim`, `OpenQuestionAnswer`, `OpenQuestionReport`, `QuestionId` and
`QuestionStatus` are named nowhere in that list, and its closing sentence assigns everything it does not name
to 9A: "Everything else under `packages/importer/src/**` is internal to 9A … and no slice imports them."
`cli.ts` imports the probe by the relative path `./catalogue/questions` (the line above), the test by
`../src/catalogue/questions`, and 9B reads `open-questions.json` — the artefact, not the function. Exporting
them here would widen a frozen registry sentence for no consumer.

- [ ] **Step 7: Run everything and commit**

Run: `bun run --cwd packages/importer test`
Expected: PASS — every suite. `fixture-driver.test.ts` still passes: `constraints()` on a corpus table with no
`constraints` key returns `[]`, which is what the base corpus has.

Run: `bun run legacy questions --fixture questions --out artefacts/legacy/dev`
Expected five lines, each ending `verdict: owner (OD-27)`, beginning:

```
VII-6 evidence_collected — Each claim is reported against what the engine declares. … verdict: owner (OD-27)
VII-7 evidence_collected — MatOpens.Job differs from 0 on 1 of 2 rows, so LEGACY-022's singleton SELECT ... INTO is a hard failure on this data, not inert. verdict: owner (OD-27)
```

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green, and `lint:rules` reports no `no-sql-concat` violation anywhere in `packages/importer/src/`.

```
feat(importer): probe the five OD-27 open questions and report the evidence [9A T13]

Part VII #6, #7, #8, #9 and #13. Adds constraints(table) to the driver port so #6 can
be answered against RDB$RELATION_CONSTRAINTS as the spec instructs, with one falsifiable
claim row per named defect (LEGACY-024, 049, 051, 066, 074). Every verdict field is null
and every answer names OD-27 as the decider (hazard 7). Lends is reported as absent from
the 460-table map rather than added to it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

### Task 14: The anonymised snapshot (spec:2272), the `all` command, the CLI's exit codes, and the runbook

**Files:**
- Create: `packages/importer/src/snapshot.ts`, `docs/runbooks/legacy-extraction.md`
- Modify: `packages/importer/src/cli.ts` (the `snapshot` and `all` commands; **correction C5** — `main` becomes testable), `docs/adr/0083-legacy-artefact-format-and-anonymisation.md` (**correction C4** — one clause of §5). **`packages/importer/src/index.ts` is deliberately not modified** — §4.13.1 calls the snapshot planner and its column rules 9A-internal (Step 4).
- Test: `packages/importer/test/snapshot.test.ts`, `packages/importer/test/cli.test.ts`

**Interfaces:**
- Consumes: `LegacyDriver`/`LegacyColumn` (T1), `ReportWriter` (T5), `unreadable` (T1), `parseArgs` (T3).
- Produces:
  ```ts
  export type PersonalKind = "name" | "identifier" | "contact" | "address" | "free_text" | "credential";
  export interface PersonalColumnRule { readonly pattern: RegExp; readonly kind: PersonalKind; readonly why: string }
  export const PERSONAL_COLUMN_RULES: readonly PersonalColumnRule[];
  export const NEVER_READ: ReadonlySet<string>;                     // "USERS.PASSWORD", "USERS.PIN"
  export interface SnapshotColumnPlan {
    readonly table: string; readonly column: string;
    readonly action: "copy" | "pseudonymise" | "omit";
    readonly kind: PersonalKind | null; readonly why: string;
  }
  export interface SnapshotResult {
    readonly generatedAt: string; readonly source: string;
    readonly tables: readonly { table: string; rows: number; file: string; sha256: string }[];
    readonly plan: readonly SnapshotColumnPlan[];
    readonly pseudonymisedColumns: number; readonly omittedColumns: number;
    readonly saltPersisted: false;
  }
  export function planSnapshot(table: string, columns: readonly LegacyColumn[]): SnapshotColumnPlan[];
  export function pseudonymise(salt: Buffer, table: string, column: string, value: string): string;
  export async function snapshot(
    driver: LegacyDriver, writer: ReportWriter,
    opts?: { readonly tables?: readonly string[]; readonly salt?: Buffer },
  ): Promise<SnapshotResult>;
  ```

**Why this exists.** spec:2272, the environments row, verbatim: "`staging` (a real Cloudflare Container against
a staging Supabase project, **seeded from an anonymised snapshot**)". The card's *Delivers* row says "the
anonymised staging snapshot (spec:2272)". This produces the anonymised extract; **0C's staging seed consumes
it and this task does not touch `packages/db/seed/`** — nothing here becomes a seed pack, a `DatasetId` or a
route (§4.16, and the plan header's "shared namespaces: none").

**Correction C4 (an amendment to ADR 0083).** ADR 0083 §5 says the pseudonym is "truncated to the column's
declared width". `LegacyColumn` (Task 1) carries `name`, `kind`, `scale` and `nullable` and **no width** — the
Firebird catalogue read in `columns()` does not select `RDB$FIELD_LENGTH`. Rather than widen a shape 9B also
reads, the rule is tightened to something stronger and checkable: the pseudonym is truncated to **the length
of the value it replaces**, so it fits every column the original fitted, and no width needs to be known.
Append this to `docs/adr/0083-legacy-artefact-format-and-anonymisation.md` under "Consequences":

```markdown
- **Amended by 9A Task 14.** §5's "truncated to the column's declared width" reads, as implemented, "truncated
  to the length of the value it replaces". `LegacyColumn` carries no declared width and widening it would
  change a shape 9B reads; the value's own length is a stricter bound and needs no catalogue column. A value
  shorter than eight characters yields a pseudonym with a real collision probability, and the snapshot plan
  says so on that column's row rather than silently lengthening it.
```

**Correction C5 (the CLI becomes testable).** `packages/importer/src/cli.ts` ends with
`process.exit(await main())` at module scope, so importing it from a test would exit the test runner. Export
`main` and guard the exit:

```ts
export async function main(): Promise<number> {
```

and, as the file's last line:

```ts
if ((import.meta as { main?: boolean }).main === true) process.exit(await main());
```

`import.meta.main` is `true` when Bun runs the file as the entry point and absent under Vitest, so the
behaviour of `bun run legacy …` is unchanged and `cli.test.ts` can call `main()` directly. The cast keeps the
`tsc` typecheck green without adding a Bun type reference to a file Node also loads.

**No correction is needed to make the CLI findable or its failures catchable.** Task 3 Step 5 already resolves
the fixture-corpus path from `import.meta.url`, calls `openDriver` inside `main`'s `try` behind a
`let opened: LegacyDriver | undefined` that only the `finally` reads, and raises rather than calling
`process.exit` when no DSN is given. So `cli.test.ts` below can call `main()` from
`bun run --cwd packages/importer test` — where the cwd is the package, not the repository root — and every
failure it asserts arrives as a return value: **2** for an unknown command, an unknown `--kind`, a missing
`--dsn` or a `--fixture` name that is not on disk, **3** for `ERR_IMPORT_SOURCE_UNREADABLE`. The one thing
still missing is C5.

- [ ] **Step 1: Write the failing snapshot test**

`packages/importer/test/snapshot.test.ts`:

```ts
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportWriter } from "../src/artefacts";
import { FixtureLegacyDriver } from "../src/drivers/fixture";
import { NEVER_READ, planSnapshot, pseudonymise, snapshot } from "../src/snapshot";
import { loadCorpus } from "./support/corpus";

const salt = Buffer.from("0".repeat(64), "hex");
const run = () => {
  const dir = mkdtempSync(join(tmpdir(), "dulja-9a-snap-"));
  return { dir, writer: new ReportWriter(dir, { source: "fixture corpus", engineVersion: "Firebird 2.5" }),
    driver: new FixtureLegacyDriver(loadCorpus()) };
};

describe("planSnapshot — every column is classified, and the plan is the artefact", () => {
  it("copies a key, pseudonymises a name, and never reads a credential", () => {
    const plan = planSnapshot("USERS", [
      { name: "ID", kind: "integer", scale: 0, nullable: false },
      { name: "NAME", kind: "text", scale: 0, nullable: true },
      { name: "PASSWORD", kind: "text", scale: 0, nullable: true },
      { name: "PIN", kind: "text", scale: 0, nullable: true },
      { name: "MOBILE", kind: "text", scale: 0, nullable: true },
      { name: "TAXNUMBER", kind: "text", scale: 0, nullable: true },
      { name: "NOTES", kind: "blob", scale: 0, nullable: true },
    ]);
    expect(plan.map((p) => [p.column, p.action, p.kind])).toEqual([
      ["ID", "copy", null],
      ["NAME", "pseudonymise", "name"],
      ["PASSWORD", "omit", "credential"],
      ["PIN", "omit", "credential"],
      ["MOBILE", "pseudonymise", "contact"],
      ["TAXNUMBER", "pseudonymise", "identifier"],
      ["NOTES", "omit", "free_text"],
    ]);
    for (const row of plan) expect(row.why.length).toBeGreaterThan(20);
  });

  it("holds the two names spec §5.1 #7 and #11 forbid, and holds them as table.column", () => {
    expect([...NEVER_READ].sort()).toEqual(["USERS.PASSWORD", "USERS.PIN"]);
  });
});

describe("pseudonymise — deterministic under one salt, unlinkable across salts (ADR 0083 §5)", () => {
  it("gives two rows that shared a value the same pseudonym", () => {
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan"))
      .toBe(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan"));
  });

  it("separates the same value in two columns, so a join cannot be rebuilt across them", () => {
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan"))
      .not.toBe(pseudonymise(salt, "EMPLOYEES", "NAME", "Ali Hassan"));
  });

  it("returns a value no longer than the one it replaces (correction C4)", () => {
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan")).toHaveLength(10);
    expect(pseudonymise(salt, "ACCOUNTS", "CODE", "1")).toHaveLength(1);
    expect(pseudonymise(salt, "ACCOUNTS", "NAME", "x".repeat(200))).toHaveLength(200);
  });

  it("changes completely under a different salt", () => {
    const other = Buffer.from("1".repeat(64), "hex");
    expect(pseudonymise(other, "ACCOUNTS", "NAME", "Ali Hassan"))
      .not.toBe(pseudonymise(salt, "ACCOUNTS", "NAME", "Ali Hassan"));
  });
});

describe("snapshot — spec:2272's anonymised extract", () => {
  it("writes one CSV per table, hashes it, and keeps the key columns joinable", async () => {
    const { dir, writer, driver } = run();
    const result = await snapshot(driver, writer, { tables: ["ACCOUNTS"], salt });

    expect(result.tables).toEqual([{ table: "ACCOUNTS", rows: 5,
      file: "snapshot/ACCOUNTS.csv", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown as string }]);
    const csv = readFileSync(join(dir, "snapshot", "ACCOUNTS.csv"), "utf8");
    expect(csv).toContain("SITE,ID,CODE,NAME,ISEMPLOYEE");
    expect(csv).toContain("1,10,");
    expect(csv).not.toContain("Cash");
    expect(csv).not.toContain("Ali Hassan");
  });

  it("never writes the salt anywhere under the run directory", async () => {
    const { dir, writer, driver } = run();
    const result = await snapshot(driver, writer, { tables: ["ACCOUNTS"], salt });
    writer.finish();
    expect(result.saltPersisted).toBe(false);
    const hex = salt.toString("hex");
    const walk = (at: string): string[] => readdirSync(at, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(join(at, e.name)) : [readFileSync(join(at, e.name), "utf8")]));
    for (const content of walk(dir)) expect(content).not.toContain(hex);
  });

  it("refuses to snapshot a table it was not asked for", async () => {
    const { writer, driver } = run();
    await expect(snapshot(driver, writer, { tables: ["NOSUCHTABLE"], salt })).rejects.toThrow(
      /ERR_IMPORT_SOURCE_UNREADABLE: NOSUCHTABLE is not a table of this source/,
    );
  });

  it("omits a denied column from the header, not just from the values", async () => {
    const corpus = loadCorpus();
    const withUsers = { ...corpus, tables: { ...corpus.tables, USERS: {
      keyColumns: ["ID"],
      columns: [
        { name: "ID", kind: "integer" as const, scale: 0, nullable: false },
        { name: "NAME", kind: "text" as const, scale: 0, nullable: true },
        { name: "PASSWORD", kind: "text" as const, scale: 0, nullable: true },
        { name: "PIN", kind: "text" as const, scale: 0, nullable: true },
      ],
      rows: [{ ID: "1", NAME: "sysdba", PASSWORD: "masterkey", PIN: "1234" }],
    } } };
    const { dir, writer } = run();
    await snapshot(new FixtureLegacyDriver(withUsers), writer, { tables: ["USERS"], salt });
    const csv = readFileSync(join(dir, "snapshot", "USERS.csv"), "utf8");
    expect(csv).toContain("ID,NAME");
    expect(csv).not.toContain("PASSWORD");
    expect(csv).not.toContain("PIN");
    expect(csv).not.toContain("masterkey");
    expect(csv).not.toContain("1234");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun run --cwd packages/importer test snapshot`
Expected: FAIL — `Cannot find module '../src/snapshot'`.

- [ ] **Step 3: Write `packages/importer/src/snapshot.ts`**

```ts
import { createHmac, randomBytes } from "node:crypto";
import type { ArtefactEntry, ReportWriter } from "./artefacts";
import { unreadable, type LegacyColumn, type LegacyDriver } from "./legacy/types";

export type PersonalKind = "name" | "identifier" | "contact" | "address" | "free_text" | "credential";

export interface PersonalColumnRule { readonly pattern: RegExp; readonly kind: PersonalKind; readonly why: string }

/**
 * Ordered; first match wins. The rules are on **column names**, because that is all a generic snapshot of 460
 * unfamiliar tables can classify on, and the plan is written into the artefact so a person can see every
 * decision the tool made and challenge it. `credential` comes first: `NEVER_READ` already stops the two names
 * spec §5.1 #7 and #11 forbid, and any other column that looks like a secret is omitted rather than
 * pseudonymised, because a pseudonymised password is still a per-user token in a file leaving the customer's
 * machine.
 */
export const PERSONAL_COLUMN_RULES: readonly PersonalColumnRule[] = [
  { pattern: /password|passwd|^pin$|secret|token|apikey|api_key/i, kind: "credential",
    why: "A credential is omitted, never pseudonymised: a stable pseudonym of a secret is still a per-user token (spec:2338, §5.1 #7)." },
  { pattern: /^(name|fullname|firstname|lastname|arabicname|englishname|contactname|guardian|father|mother|patient|student|teacher|employeename)$/i,
    kind: "name", why: "A person's name identifies them directly; it is replaced by a stable pseudonym so joins still work." },
  { pattern: /taxnumber|regnumber|passport|nric|^ic$|icno|identity|nationalid|licence|license|bankaccount|iban|cardno/i,
    kind: "identifier", why: "A government or financial identifier is a direct identifier and is replaced by a stable pseudonym." },
  { pattern: /mobile|phone|tel|fax|email|mail|whatsapp/i, kind: "contact",
    why: "A contact detail identifies a person and is replaced by a stable pseudonym." },
  { pattern: /address|street|city|postcode|zip|location|coordinate|latitude|longitude/i, kind: "address",
    why: "An address locates a person or a household and is replaced by a stable pseudonym." },
  { pattern: /note|notes|remark|comment|description|memo|detail$/i, kind: "free_text",
    why: "Free text cannot be classified column-wise — an operator may have typed anything into it — so it is omitted." },
];

/** spec §5.1 #7 and #11: `Users.Password` and `Users.PIN` are never imported and, here, never read. */
export const NEVER_READ: ReadonlySet<string> = new Set(["USERS.PASSWORD", "USERS.PIN"]);

export interface SnapshotColumnPlan {
  readonly table: string;
  readonly column: string;
  readonly action: "copy" | "pseudonymise" | "omit";
  readonly kind: PersonalKind | null;
  readonly why: string;
}

export interface SnapshotResult {
  readonly generatedAt: string;
  readonly source: string;
  readonly tables: readonly { table: string; rows: number; file: string; sha256: string }[];
  readonly plan: readonly SnapshotColumnPlan[];
  readonly pseudonymisedColumns: number;
  readonly omittedColumns: number;
  readonly saltPersisted: false;
}

/** Every column of a table gets exactly one row, in the catalogue's own order. Nothing is left unclassified. */
export function planSnapshot(table: string, columns: readonly LegacyColumn[]): SnapshotColumnPlan[] {
  return columns.map((column) => {
    if (NEVER_READ.has([table, column.name].join("."))) {
      return { table, column: column.name, action: "omit", kind: "credential",
        why: "On the deny-list: spec §5.1 #7 and #11 forbid reading this column at all (LEGACY-028)." };
    }
    if (column.kind === "blob") {
      return { table, column: column.name, action: "omit", kind: "free_text",
        why: "A blob is opaque bytes that may contain anything, including a scan of an identity document; it is omitted." };
    }
    for (const rule of PERSONAL_COLUMN_RULES) {
      if (!rule.pattern.test(column.name)) continue;
      const action = rule.kind === "credential" || rule.kind === "free_text" ? "omit" : "pseudonymise";
      return { table, column: column.name, action, kind: rule.kind, why: rule.why };
    }
    return { table, column: column.name, action: "copy", kind: null,
      why: "No rule classifies this column as personal, so the value is copied — a code, a quantity, a date or a foreign key." };
  });
}

/**
 * ADR 0083 §5, as amended by correction C4: `HMAC-SHA256(salt, table || column || value)` rendered as hex and
 * truncated to **the length of the value it replaces**, so the pseudonym fits every column the original fitted.
 * The table and column are inside the message, so the same customer name in two columns yields two different
 * pseudonyms and a join the source did not have cannot be rebuilt from the snapshot. The salt is per run and
 * never written down, so the mapping is irreversible even to whoever produced the file.
 */
export function pseudonymise(salt: Buffer, table: string, column: string, value: string): string {
  if (value.length === 0) return "";
  let hex = "";
  for (let counter = 0; hex.length < value.length; counter += 1) {
    hex += createHmac("sha256", salt).update([table, column, value, String(counter)].join("\u0000")).digest("hex");
  }
  return hex.slice(0, value.length);
}

/**
 * spec:2272 — the anonymised snapshot `staging` is seeded from. It writes one CSV per requested table with the
 * omitted columns absent from the header as well as from the rows, and it writes the classification plan
 * beside them so the anonymisation is auditable rather than asserted. **The salt is not written**: nothing in
 * the run directory can reverse a pseudonym, which is the property that lets the file leave the customer's
 * premises at all.
 */
export async function snapshot(
  driver: LegacyDriver, writer: ReportWriter,
  opts: { readonly tables?: readonly string[]; readonly salt?: Buffer } = {},
): Promise<SnapshotResult> {
  const salt = opts.salt ?? randomBytes(32);
  const present = new Set(await driver.tables());
  const wanted = opts.tables ?? [...present].sort();
  for (const table of wanted) {
    if (!present.has(table)) throw unreadable(`${table} is not a table of this source`);
  }

  const plan: SnapshotColumnPlan[] = [];
  const tables: { table: string; rows: number; file: string; sha256: string }[] = [];

  for (const table of wanted) {
    const columns = await driver.columns(table);
    const tablePlan = planSnapshot(table, columns);
    plan.push(...tablePlan);
    const kept = tablePlan.filter((p) => p.action !== "omit");
    const rows: Record<string, unknown>[] = [];
    for await (const batch of driver.cursor({ table, columns: kept.map((p) => p.column) }, 500)) {
      for (const row of batch) {
        const out: Record<string, unknown> = {};
        for (const column of kept) {
          const value = row[column.column];
          out[column.column] = column.action === "pseudonymise" && typeof value === "string"
            ? pseudonymise(salt, table, column.column, value)
            : value;
        }
        rows.push(out);
      }
    }
    const entry: ArtefactEntry = writer.csv(["snapshot/", table, ".csv"].join(""), rows);
    tables.push({ table, rows: rows.length, file: entry.name, sha256: entry.sha256 });
  }

  const result: SnapshotResult = {
    generatedAt: [new Date().toISOString().slice(0, 19), "Z"].join(""),
    source: driver.source, tables, plan,
    pseudonymisedColumns: plan.filter((p) => p.action === "pseudonymise").length,
    omittedColumns: plan.filter((p) => p.action === "omit").length,
    saltPersisted: false,
  };
  writer.json("snapshot-plan.json", result, plan.length);
  writer.csv("snapshot-plan.csv", plan.map((p) => ({ table: p.table, column: p.column, action: p.action, kind: p.kind ?? "", why: p.why })));
  return result;
}
```

An **omitted column never reaches the `SelectSpec`**, so a denied value is not read out of the database and
then dropped — it is never selected. That is what "never read" in the Global Constraints table means, and the
last test in Step 1 is what holds it: the header of `USERS.csv` has no `PASSWORD` column to drop.

- [ ] **Step 4: Add the `snapshot` and `all` commands**

In `packages/importer/src/cli.ts`, two branches beside `questions`:

```ts
    if (args.command === "snapshot") {
      const reader = await createReader(driver, args.flags["firebird-version"]);
      const writer = new ReportWriter(out, { source: driver.source, engineVersion: reader.firebirdVersion });
      const only = args.flags.tables;
      const result = await snapshot(driver, writer, only ? { tables: only.split(",").map((t) => t.trim().toUpperCase()) } : {});
      const index = writer.finish();
      console.log(["snapshot:", String(result.tables.length), "tables,",
        String(result.tables.reduce((a, t) => a + t.rows, 0)), "rows,",
        String(result.pseudonymisedColumns), "columns pseudonymised,",
        String(result.omittedColumns), "omitted"].join(" "));
      console.log("salt: generated per run and not written — a pseudonym here cannot be reversed (ADR 0083)");
      console.log(["wrote:", String(index.artefacts.length), "artefacts ->", out].join(" "));
      return 0;
    }

    if (args.command === "all") {
      // The five report commands, in the order the runbook runs them. `snapshot` is deliberately not among
      // them: it produces pseudonymised customer data for staging, which is a separate decision from
      // "profile and reconcile the source", and spec:2272 puts it in a different environment's path.
      const reader = await createReader(driver, args.flags["firebird-version"]);
      const writer = new ReportWriter(out, { source: driver.source, engineVersion: reader.firebirdVersion });
      const scopeReport = await scope(driver);
      writer.json("scope.json", scopeReport, scopeReport.tables.length);
      const profileReport = await profile(reader);
      writer.json("profile.json", profileReport, profileReport.tables.length);
      for (const kind of RECONCILIATION_KINDS) {
        const report = await reconcile(reader, kind);
        writer.json([kind, "json"].join("."), report, report.rows.length);
        writer.csv([kind, "csv"].join("."), report.rows as Record<string, unknown>[]);
        console.log([kind, ":", String(report.rows.length), "findings"].join(" "));
      }
      const templates = await catalogueTemplates(driver, writer);
      writer.json("templates.json", templates, templates.entries.length);
      const questions = await answerOpenQuestions(reader, driver);
      writer.json("open-questions.json", questions, questions.answers.length);
      const index = writer.finish();
      console.log(["engine:", reader.firebirdVersion].join(" "));
      console.log(["wrote:", String(index.artefacts.length), "artefacts ->", out].join(" "));
      console.log("next: the owner reads reconciliation and open-questions, and answers OD-16, OD-25 and OD-27");
      return 0;
    }
```

with `import { snapshot } from "./snapshot";` and the usage line finalised to:

```ts
    console.log("usage: bun run legacy <scope|profile|reconcile|templates|questions|snapshot|all> [--dsn <dsn> | --fixture <name>] [--mpos-dsn <dsn>] [--include-mpos] [--firebird-version <v>] [--kind <k>] [--tables A,B] [--out <dir>]");
```

**`packages/importer/src/index.ts` is not edited by this task, and that is deliberate.** §4.13.1's closing
sentence names the snapshot explicitly among the things that never cross: "Everything else under
`packages/importer/src/**` is internal to 9A — the per-rule tables and row shapes of the six reconciliation
kinds, **the snapshot planner and its column rules**, the SQL renderer, the CLI's own
`parseArgs`/`CliArgs`/`main` — and no slice imports them." So `snapshot`, `planSnapshot`, `pseudonymise`,
`PERSONAL_COLUMN_RULES`, `NEVER_READ`, `PersonalColumnRule`, `PersonalKind`, `SnapshotColumnPlan` and
`SnapshotResult` are reached only by relative path: `cli.ts` by `./snapshot` (the import line above) and
`test/snapshot.test.ts` by `../src/snapshot`. With Task 13's line the barrel already holds exactly §4.13.1's
list, and this task leaves it at exactly that.

- [ ] **Step 5: Write `packages/importer/test/cli.test.ts`**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../src/cli";

const out = () => mkdtempSync(join(tmpdir(), "dulja-9a-cli-"));
const argv = (...args: string[]): void => { process.argv = ["bun", "cli.ts", ...args]; };

afterEach(() => { vi.restoreAllMocks(); });

describe("parseArgs", () => {
  it("separates flags from switches and defaults the command to help", () => {
    expect(parseArgs([])).toEqual({ command: "help", flags: {}, switches: new Set() });
    expect(parseArgs(["scope", "--fixture", "base", "--include-mpos", "--out", "x"])).toEqual({
      command: "scope", flags: { fixture: "base", out: "x" }, switches: new Set(["include-mpos"]),
    });
  });

  it("treats a flag followed by another flag as a switch, not as a flag with a flag-shaped value", () => {
    expect(parseArgs(["scope", "--include-mpos", "--fixture", "base"]).flags).toEqual({ fixture: "base" });
  });
});

describe("main — exit codes are the contract the runbook relies on", () => {
  it("returns 0 for help and prints every command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    argv("help");
    expect(await main()).toBe(0);
    const usage = String(log.mock.calls[0]?.[0]);
    for (const command of ["scope", "profile", "reconcile", "templates", "questions", "snapshot", "all"]) {
      expect(usage).toContain(command);
    }
  });

  it("returns 0 for a full run against the corpus", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    argv("all", "--fixture", "base", "--out", out());
    expect(await main()).toBe(0);
  });

  it("returns 2 for an unknown command", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    argv("migrate", "--fixture", "base", "--out", out());
    expect(await main()).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toBe("config: unknown command migrate");
  });

  it("returns 2 for an unknown reconciliation kind and names the six that exist", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    argv("reconcile", "--kind", "employees", "--fixture", "base", "--out", out());
    expect(await main()).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("expected all or one of aggregate_drift");
  });

  it("returns 2 for a --fixture name that is not on disk, from either working directory", async () => {
    // This case is why the corpus path is resolved from `import.meta.url` and why `openDriver` is called
    // inside `main`'s try: with a cwd-relative path and the call outside the try, the ENOENT here would be an
    // unhandled rejection under Vitest instead of a return value — and `--fixture base` above would fail too,
    // because this suite runs with cwd = packages/importer while the root `legacy` script does the same.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    argv("scope", "--fixture", "nosuchcorpus", "--out", out());
    expect(await main()).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("nosuchcorpus");
  });

  it("returns 3 when the source cannot be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    argv("snapshot", "--fixture", "base", "--tables", "NOSUCHTABLE", "--out", out());
    expect(await main()).toBe(3);
    expect(String(error.mock.calls[0]?.[0])).toContain("ERR_IMPORT_SOURCE_UNREADABLE: NOSUCHTABLE is not a table of this source");
  });
});
```

- [ ] **Step 6: Run everything**

Run: `bun run --cwd packages/importer test`
Expected: PASS — every suite, including the two new files.

Run: `bun run legacy all --fixture base --out artefacts/legacy/dev`
Expected the six reconciliation lines, then:

```
engine: WI-V2.5.9.27139 Firebird 2.5
wrote: 21 artefacts -> artefacts/legacy/dev
next: the owner reads reconciliation and open-questions, and answers OD-16, OD-25 and OD-27
```

Run: `bun run legacy snapshot --fixture base --tables ACCOUNTS,VOUCHERS --out artefacts/legacy/dev-snap`
Expected:

```
snapshot: 2 tables, 7 rows, 1 columns pseudonymised, 0 omitted
salt: generated per run and not written — a pseudonym here cannot be reversed (ADR 0083)
wrote: 5 artefacts -> artefacts/legacy/dev-snap
```

Run: `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test`
Expected: green across every workspace.

- [ ] **Step 7: Write `docs/runbooks/legacy-extraction.md`**

```markdown
# Runbook — extracting and profiling the legacy database (Phase 9A)

This runbook produces the evidence the owner needs to answer OD-16, OD-25 and OD-27, and the numbers that
size the Phase 1 and 3 load tests (spec:2267). It **loads nothing into Dulja** — that is 9B.

## What the owner provides

| Item | Ledger | Why |
|---|---|---|
| A read-only ODBC DSN for the main legacy database | OD-17 | every command below |
| The Firebird version, if the engine is older than 2.1 | OD-17 | `LegacyReader.firebirdVersion` is required and is never inferred (ADR 0081) |
| A second DSN for the `mpos` database — **only if** historical POS data must migrate | OD-16 | `--mpos-dsn`; the default is to start clean |

**Verify the access before anything else:**

    bun run legacy scope --dsn "$LEGACY_ODBC_DSN" --out artefacts/legacy/scope

prints `engine: <version>`, a `tables:` line and a `rows:` line, and writes `scope.json`. If the engine does
not answer `ENGINE_VERSION` the command exits **2** and says to pass `--firebird-version <string>`; that
string is what ADR 0081 records.

**Until the owner provides a DSN**, every command below runs identically against the committed synthetic
corpus by replacing `--dsn "$LEGACY_ODBC_DSN"` with `--fixture base`, and prints the same lines with the
corpus's own numbers. No step of this runbook is blocked on the owner; only the *answers* are.

## Taking the extract

Which of the three methods Part VII #5 lists — reading production directly, restoring a `gbak` backup into a
throwaway instance, or attaching a copied `.fdb` — is recorded in ADR 0081. **The code is the same in all
three**; the choice is about who takes the backup, on which machine, and with what downtime. Prefer a restored
backup: the reader only ever issues `select`, but a read against a live accounting database during business
hours is a risk with no upside.

## The order, and why

1. `scope` — row counts and date ranges per table. §5.1 #10: "scope first, migrate second." Nothing else runs
   until somebody has looked at this file: it is what says whether the hospital (50 tables), academy (44) and
   aviation modules are dead weight (Part VII #1).
2. `profile` — the same numbers plus `modulesInUse`, in the frozen §4.13.1 shape 9B consumes.
3. `reconcile --kind all` — the six reports of §5.1 #1–#5 and #12. **Read `aggregate_drift` first**, and read
   `duplicate_aggregates` beside it: a duplicated key makes the stored figure wrong by exactly the excess.
4. `templates` — every report definition out of `System.Reports` as a hashed file (§5.1 #9).
5. `questions` — the OD-27 evidence for Part VII #6, #7, #8, #9 and #13.

Or all five at once:

    bun run legacy all --dsn "$LEGACY_ODBC_DSN" --out artefacts/legacy/$(date +%F)

## The staging snapshot

Separate, and deliberately not part of `all`:

    bun run legacy snapshot --dsn "$LEGACY_ODBC_DSN" --tables ACCOUNTS,MATERIALS --out artefacts/legacy/snap

Every column classified as personal is replaced by a pseudonym under a per-run salt that is **never written**,
free text and blobs are omitted, and `Users.Password` and `Users.PIN` are never selected at all. Read
`snapshot-plan.csv` before the snapshot leaves the customer's premises: it lists every column and what was
done to it. This is what seeds `staging` (spec:2272).

## What the owner does with the artefacts

- **OD-25** (9B's gate): `unbalanced_vouchers.csv` gives the count and the total imbalance. The owner agrees
  the suspense treatment *before* migrating (§5.1 #2). The account is `3900` whatever they decide.
- **OD-16**: `mpos-decision.json`, if a `--mpos-dsn` was given, carries the ticket count and date range.
- **OD-27**: `open-questions.csv`. Every `verdict` column is empty on purpose.

## Handling the artefacts

`artefacts/` is in `.gitignore` and **is never committed** — the files are customer data. Keep them where the
customer's own backups are kept, and when the owner signs off a figure cite **that artefact's `sha256` as
`index.json` records it** — not `index.json`'s own entry, whose digest is empty because a file cannot carry the
hash of its own bytes (ADR 0083 §2) — so months later 9B's cut-over can prove which file was agreed.
```

- [ ] **Step 8: Commit**

```
feat(importer): anonymised staging snapshot, the `all` command, and the runbook [9A T14]

spec:2272's snapshot: every column is classified against ordered rules, personal values
become HMAC pseudonyms under a per-run salt that is never written, blobs and free text
are omitted, and Users.Password/Users.PIN are never selected — the plan is written beside
the data so the anonymisation is auditable. Correction C4 amends ADR 0083 §5 to truncate
to the replaced value's length; C5 exports `main` so the CLI's exit codes are tested
rather than asserted. docs/runbooks/legacy-extraction.md is the owner-facing sequence.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Self-Review

Reviewed against the writing-plans skill, the contracts card for 9A (§2.9), all of §3, §4.13, §5's thirty-five
hazards and the §6 matrices. What follows is what the review changed and what it deliberately left alone.

### The card's own checklist

| Card row | Where it lands | Verdict |
|---|---|---|
| `packages/importer` (§4.13.1) — `LegacyReader` over Firebird | T1 (port), T3 (live driver), T4 (`LegacyReader` verbatim) | ✅ |
| …"typed row readers for the tables named in §5.1 and §0.4" | `read<T>` (T4) + each report's own local row shape; no per-table interface is produced anywhere | ✅ **settled, not pending** — §4.18 Round 2 ratified this reading and the card's *Delivers* bullet now says "typed row **reads** … and no per-table row interface"; the plan matches the amended card |
| Profiler: per-table row counts and date ranges (Part VII #1, #2, #13) | T3 (`scope`), T5 (`profile`), T13 (#13) | ✅ |
| The anonymised staging snapshot (spec:2272) | T14 | ✅ |
| §5.1 #1 recompute every stored aggregate | T7 | ✅ |
| §5.1 #2 unbalanced vouchers with quantification | T8 | ✅ |
| §5.1 #3 orphan report | T9 | ✅ |
| §5.1 #4, #5 NULL-poison and duplicate aggregates | T10 | ✅ |
| §5.1 #12 employee duplicate mapping | T11 | ✅ |
| §5.1 #9 report-template blob extraction (feeds 7B/7C) | T12 | ✅ |
| Part VII #9 customisation catalogue | T13 (question VII-9) | ✅ |
| Cut-over decision inputs: suspense (§5.1 #2), POS history (Part VII #10) | T8 (`SUSPENSE_QUESTION`), T6 (`mposDecision`) | ✅ |
| Migration range 0100 — reserved, unused | no file in `packages/db/migrations/` anywhere in this plan | ✅ |
| ADRs 0081, 0082, 0083 | T3, T2, T5 (amended in T14) | ✅ |
| Owner gates OD-17, OD-16, OD-27 as isolated tasks | T3, T6, T13 — one each, each droppable | ✅ |
| Part VI tests owned / re-run: none | none appear | ✅ |
| §3.0.4 rows owned: none | none appear | ✅ |
| Regression files: legacy-077 appends, create-if-absent | T12 Step 6, with the corollary quoted | ✅ |
| Import-validation tests for §5.1 #1–#5, #12 in `packages/importer/test`, not `tests/regression/` | T7–T11 all put them there | ✅ |

**The two former divergences from frozen contracts text — both now ratified, and what remains of each.**
Neither was ever the plan overriding the document on its own authority: both were filed as amendment requests,
and **§4.18 Round 2 accepted both**. The card's *Target size* cell now reads "8–10 tasks for the reports, plus
one isolated task per owner gate (OD-16, OD-17, OD-27) — **14 as written**", and its *Owner gates* cell "the
scoping report is the first task that reads the owner's data: 9A Task 3". The reasoning below is kept as the
record of why, and as the fallback an executor uses **only** if a future round reverses either.

1. **Task count.** The card's *Target size* was "8–10 tasks (deliberately short)"; this plan has **14**.
   Compressing further would mean merging an owner gate into a working task, and hazard 6 forbids exactly that
   ("one task per OD item, droppable without renumbering neighbours' interfaces"): three of the fourteen are
   gates that must stand alone (T3, T6, T13), and the card itself asks for six reconciliation reports, a
   template catalogue, a snapshot and a profiler. The reports are one task each because each is a separate
   `kind` in the frozen §4.13.1 union and each has its own corpus rows; merging two would give one task two
   failing tests at once. No task exists here that the card did not ask for — the widening the card now
   carries is of the count alone and adds no deliverable.
2. **Which task is the scoping task.** The card's OD-17 row and hazard 3 used to say "Task 1 is the scoping
   task"; here `scope` is **Task 3**, because Tasks 1–2 build the driver port and the renderer it plugs into
   and neither reads a byte of the owner's data. The substance of §5.1 #10 ("scope first, migrate second") is
   preserved — T3 is still the first task that touches the customer's database, and it is the first the owner
   is asked to unblock. §4.18 Round 2 settled it in exactly those words, and the §2.10 card and hazard 3 both
   carry the new wording. **One stale cell survives in the contracts document and is its architect's to fix,
   not this plan's:** §2.12's OD-17 row still reads "9A → Task 1 (scoping)". It is contradicted by §2.10, by
   §4.18 and by §5.3, so an executor follows those three. **The alternative, should a later round reverse the
   settlement, is still concrete:** fold `scope` and the live driver into Task 1 and renumber 2–14 down by
   two; Task 1 then carries the OD-17 gate block, and the fixture driver and the renderer become its
   Steps 1–8. Nothing else in the plan changes.

### Hazards checked one by one

- **1 (no statutory rates):** no rate, threshold, ceiling or formula appears. T11 and T13 touch the payroll
  *tables* and count their rows; neither reads a `TAXLAYERS` value, and §5.1 #11's "never import `TaxLayers`"
  is quoted rather than worked around. ✅
- **2 (no invented MyInvois detail):** no LHDN endpoint, field or schema version anywhere. ✅
- **3 (the Firebird version is unknown):** assumption 1, T3's probe, T4's refusal to construct a reader without
  a version, ADR 0081. Nothing infers a version from a driver string or a file header. ✅
- **5 (owner-account pattern):** T3, T6 and T13 each carry Owner provides / Verify / Until answered, and the
  runbook repeats it with the exact commands. ✅
- **6, 7 (isolated gates; never re-decide):** three gate tasks, each with the §2.12 default written in and a
  `verdict`/`answer` field that is `null` by construction. No D1–D27 decision is re-opened. ✅
- **8, 9 (Plan 0A names; `fixtures.ts`):** no Plan 0A helper is used or renamed — this package opens no
  PostgreSQL connection — and `packages/db/test/fixtures.ts` is not opened. ✅
- **10, 11, 12, 13, 14 (migrations):** no migration file, no enum label, no `lint-schema.ts` edit, no
  renumbering. 0100 stays unused. ✅
- **21 (`sql.unsafe` has three homes):** none of the three is used; `reader.ts`'s allow-list entry stays a
  permission (assumption 11). ✅
- **22 (nothing outside posting writes ledger tables):** this package issues no `insert`, `update` or `delete`
  against anything — every rendered statement begins with `select` and T2's test asserts it. ✅
- **32 (no literal in a shared namespace):** no document-type code, account code, report code, `DatasetId`
  member or `fixtures.ts` helper. The one shared literal is `ERR_IMPORT_SOURCE_UNREADABLE`, which §4.2.4
  already allocates to "Firebird reader (9A)". ✅
- **35 (plans are written to the skill):** every task has exact paths, exact signatures copied from §4.13.1, a
  failing test with the exact expected failure, real code, and a commit. Searched for the ASCII placeholders
  ("TBD", "TODO", "implement later", "similar to Task", "and so on", "etc.") **and for U+2026 `…`**, which the
  first pass of this review missed because the grep was ASCII-only: three code blocks used an ellipsis to
  stand in for unchanged code (T6 Step 5's `profile`, T13's `LegacyDriver` line, and the withdrawn C6 block)
  and all three are now explicit — T6 shows the whole function, T13 names the insertion point, C6 is gone.
  **Every test expectation in this plan is a computed value, not a value to be read off a failure diff.** T7's
  six `summary` counters and its row count are traced against the committed corpus in Step 2's own prose
  (23/6/1/2/13/6, 22 rows), T10 Step 1 carries the exact one-line edit that makes `drifting` 2 and 23 rows,
  and T10's `poisonedColumns` is 4 with the four columns named. The earlier revision's "run the test once,
  read the numbers off the failure diff, and paste them in" was hazard 35 in another spelling and is deleted;
  the arithmetically impossible numbers it left behind (`compared` + `notDerivable` + `sourceAbsent` summing to
  more than `rules`) were the proof it had never been run. The only `<placeholder>`s that remain are inside
  the three owner-gate *Verify* blocks, where the value is the owner's database's and cannot be known here. ✅

### Defects carried as corrections, and where each is fixed

Four remain as *corrections* — a later task applying an exact diff to an earlier task's file, so an engineer
who has already executed the earlier tasks applies four small edits and nothing else. Their labels are stable:
C2 and C4 are named in shipped code comments, an ADR paragraph and a test title, so nothing is renumbered when
a correction is withdrawn.

| # | Defect | Fixed in |
|---|---|---|
| **C1** | **Five** earlier suites pin the base corpus's exact table list or its size, and T7, T9, T10, T11 and T12 all add tables to `test/corpus/base/`: `fixture-driver.test.ts` and `reader.test.ts` assert `tables()` equals `["ACCOUNTS", "VOUCHERS", "VOUITEMS"]`; `profile.test.ts` asserts an exact three-element `report.tables`; `scope.test.ts` pins an exact `report.tables`, `totalRows` of 9 and `missingTables` of 457; `mpos-scope.test.ts` pins both `profile` lists. | **T7 Step 1**, where the corpus first grows — sorted-plus-membership for the two `tables()` assertions, by-name lookups in `profile`/`scope`, `totalRows` a lower bound, `missingTables` expressed as `ALL_LEGACY_TABLES.size − tables.length + unexpectedTables.length`, and `mpos-scope` restated as the *difference* the filter makes. T11 then makes three one-line content edits (`ACCOUNTS` 3 → 5 in two files, `modulesInUse.salaries` false → true) and nothing else in any of the five moves. |
| **C2** | `coerce` in `odbc.ts` turns a blob `Buffer` into `String(value).trim()` — a lossy UTF-8 decode that corrupts every byte above 0x7F, which for a serialised Delphi report object is most of them. `CAST_WIDTH.blob` is `null`, so the renderer correctly does not cast it; the driver was dropping it. | **T12**, base64 across the seam, `LegacyScalar` unchanged |
| **C4** | ADR 0083 §5 specifies the pseudonym "truncated to the column's declared width", but `LegacyColumn` carries no width and `columns()` does not select `RDB$FIELD_LENGTH`. | **T14**, ADR amended to "the length of the value it replaces" — a stricter bound needing no catalogue column |
| **C5** | `cli.ts` ends with `process.exit(await main())` at module scope, so no test can import it; the plan nevertheless promises `cli.test.ts` asserting exit codes. | **T14**, `main` exported and the exit guarded by `import.meta.main` |

**Two corrections were withdrawn, because both were defects in code this plan writes and both are now written
correctly where the code is first typed.** A correction that lands ten tasks after the defect leaves the tree
in a state the plan itself calls green while it is not, which is worse than a longer Task 3.

- **The former C3 (`odbc.ts`'s `+`-joined statements)** is fixed in **T3 Step 3**: `tables`, `columns` and
  `keyColumns` are single unbroken template literals, with the reason stated there. **Its old justification was
  wrong and is corrected:** it claimed `bun run lint:rules` would fail. It would not — 0B's shipped rule is
  `CONCAT = /["'][^"']*\b(select|from|where)\b[^"']*["']\s*\+/i` (0B:5014), which matches only single- or
  double-quoted delimiters, and its template branch additionally requires `body.includes("${")`; neither fires
  on `+`-joined backtick literals with no interpolation. The binding constraint is **spec:100** itself —
  "never build SQL by string concatenation (LEGACY-036/037/069)", copied verbatim into this plan's Global
  Constraints — which admits no exception for a `+` whose operands happen to be literal. The rule is narrower
  than the rule it enforces, and the house rule wins.
- **The former C6 (the fixture-corpus path and the un-caught `openDriver` throw)** is fixed in **T3 Step 5**:
  the path is resolved from `import.meta.url`, `openDriver` is called inside `main`'s `try` behind a
  `let opened` the `finally` reads, and `openDriver` raises instead of calling `process.exit` so `main()` is
  importable. **Its old diagnosis was wrong and is corrected:** it said the cwd-relative path "only resolves
  when the command runs from the repository root". The root script is
  `"legacy": "bun run --cwd packages/importer src/cli.ts"`, so the cwd of every `bun run legacy …` invocation
  is `packages/importer` and the path resolved **nowhere** — `join("packages/importer/test/corpus", fixture)`
  became `packages/importer/packages/importer/test/corpus/<name>`. That is why this mattered more than a test
  ergonomics nit: eleven `--fixture` verification steps across nine tasks (T3 Step 7, T5 Step 7, T6 Step 8,
  T7 Step 9, T8 Step 5, both `reconcile` runs in T11 Step 8, T12 Step 7, T13's "Until answered" run and
  T14's two) were unrunnable, and because the call sat outside the `try` the failure was an unhandled
  rejection rather than exit 2 or 3. T14's `cli.test.ts` now also carries a `--fixture nosuchcorpus` case so
  the path cannot silently regress. `openDriver` raising rather than exiting is part of the same fix: C5 asks
  for `main()` to be callable from a test, and a `process.exit` inside it would kill the runner.

Two more expectations moved as a consequence of the corpus growing, and are already right in the tasks as
written: `ACCOUNTS` is **5** rows from T11 onward (both places named in T11's opening list), and the `all`
command writes **twenty-one** artefacts against the base corpus, not eighteen — the four `.report` blobs
`catalogueTemplates` writes count as artefacts and were missed on the first pass. The blob fixtures are **nine
bytes, twelve base64 characters, unpadded**, so `Buffer.from(bytes).toString("base64")` round-trips to the
identical literal; a padded literal would decode to a different length than it looks like.

### Defects in test expectations found by the second review pass, and fixed in place

These were wrong *assertions*, not wrong code, so each is corrected where it is written rather than carried as
a correction. Every one made a step the plan marks "see them pass" unreachable.

| Where | Was | Is |
|---|---|---|
| T2 Step 1, `quoteIdent` | `"DROP TABLE"` expected to raise "is not a declared column" | it contains a space, so the **shape** gate raises first: "is not a bare Firebird identifier". A `"NOSUCH"` case now exercises the membership message and a `"VOUITEMS"` case `projection`'s own |
| T2 Step 4, the `in` branch | shipped `.replace("in (", "in (")` — a no-op the prose then told the reader to delete | the corrected expression is in the code block; the prose explains the leading space instead |
| T3 Step 1, "records a table it cannot read" | relied on `FixtureLegacyDriver.columns` raising for a table with `columns: []` — it returns `[]` and `count` returns 0, so `note` was `null` | `scope` checks `columns.length === 0` explicitly and pushes the same `"no columns declared"` note the ODBC path produces |
| T5 Step 1, `index.json` | `finish()` serialised the index **before** pushing its own entry, so the file held two artefacts while the return value held three | `finish()` builds the self-entry first and writes the array that contains it; the test now also asserts file ≡ return value |
| T7 Step 2, `summary` | `rules: "16"`, `compared: "3"`, `drifting: "2"`, `missingStoredRows: "1"`, `sourceAbsent: "12"` — 23 rules exist, and 13 + 12 + 3 cannot come out of 16 | the traced values: 23 / 6 / 1 / 2 / 13 / 6, with the derivation written out beside them |
| T7 Step 2, `missing_stored_row` | `ACCOBJECTS.DEBIT` at `1|11` expected `recomputed: "0.0000"` | `VOUITEMS` sums 0 + 250 on that key, so `"250.0000"`; the `.CREDIT` row (`"100.0000"`) is asserted too |
| T10 Step 2, `poisonedColumns` | `"2"` | `"4"` — `ACCOBJECTS.OPENDEBIT` and `.OPENCREDIT` are null in T7's corpus row, on top of `ACCTOTALS.CREDIT` and `MATOBJECTS.QNT`; both are now asserted by name |
| T13 Step 3, LEGACY-074 | expected "1 of 10 tables **declares** no PRIMARY KEY" against an implementation that builds "declare" | the expectation says "declare", matching the implementation, which uses one word for a count that is usually plural |
| T6 *Verify* | `legacy scope --mpos-dsn …` alone, which exits 2 in `openDriver` before the `--mpos-dsn` branch is reached | both DSNs, with the reason stated |
| C1's scope | named two files (`profile.test.ts`, `scope.test.ts`) | **five** — `fixture-driver.test.ts`, `reader.test.ts` and `mpos-scope.test.ts` also pin the exact base-corpus table list, and were masked only because T7–T9 used to run filtered suites. Upgrading those steps to whole-package runs is what exposed them. |

### Interface fidelity

§4.13.1's five members are implemented verbatim, checked character by character: `LegacyReader` (T4 — mutable
method set, `firebirdVersion` a required `string`, `read`'s `opts` object literal in the frozen order),
`ProfileReport` (T5 — mutable members, optional `dateRange`), `ReconciliationReport` (T7 — the closed
six-member `kind` union, `rows: Record<string, unknown>[]`, `summary: Record<string, string>`; T11's test
asserts every `summary` value is a string), `profile(reader, opts?)` and `reconcile(reader, kind)`.
`LegacyPredicate` is 9A's own by the §4 preamble and is defined once, in T1/T2.

**The barrel is §4.13.1's barrel list exactly — no name more, no name fewer — and that was checked name by
name after the review found it had been both.** It was **short** by `ProfileOptions`, which §4.13.1 lists
beside `profile` and `ProfileReport` and which no task exported (T6 declared it in `profile.ts` and stopped
there), so 9B's `import type { ProfileOptions } from "@dulja/importer"` would not have compiled; **T6 Step 6**
now widens T5's line and is the fix. It was **long** by two groups that §4.13.1's closing sentence puts inside
9A — the snapshot planner and its column rules (T14) and the whole open-question group (T13) — and both blocks
are withdrawn: `cli.ts` and the tests reach them by relative path, no slice imports them, and the sentence
"the snapshot planner and its column rules … no slice imports them" is honoured rather than quietly widened.
With those two corrections **nothing in §4.13.1 is widened**, and the handoff's claim that 9B receives "the
§4.13.1 surface, unwidened" is literally true.

The one addition to a shared *port* is `LegacyDriver.constraints(table)` in T13 — and it is no longer an
addition at all: §4.18 Round 2 folded "the driver port `LegacyDriver` (with `constraints`), `LegacyConstraint`"
into §4.13.1, and the code block there now carries both. T13 implements a registry shape rather than extending
one.

### What a reviewer should push back on

1. **The recompute formulae are hypotheses** (assumption 8), and `AGGREGATE_RULES`' `not_derivable` rows are
   the honest admission that the `Admin*`/`Internal*`/`Order*`/`Transferred*` routing lives in 318 triggers and
   fifteen unexamined DLLs. If the owner can supply the routing, those rows become `verified` and the drift
   report gets sharper — that is a data change, not a code change, which is why the table is declarative.
2. **`EMPLOYEE_MATCH_STRATEGIES` guesses nothing but assumes two things**: that `EMPLOYEES.ACCOUNT` holds an
   account *id* rather than an account *code*, and that name folding is safe on this customer's Arabic data.
   Both are `hypothesis` and both are printed on every row. If the owner says `ACCOUNT` is a code, one line of
   the lookup changes and the confidence stays where it is.
3. **`TEMPLATE_GROUP_RULES` is a rule set, not the dossier's 255 names.** A transcribed list would be
   unverifiable and would rot on the first clone the customer makes; the rules are tested against the
   dossier's own named examples. `unknown` is a real answer and appears in the CSV.
4. **The snapshot classifies on column names alone.** That is all a generic tool over 460 unfamiliar tables
   can do, and it is why `snapshot-plan.csv` exists and why the runbook says to read it before the file leaves
   the customer's premises. A column named `FIELD7` holding a phone number would be copied — the plan row
   says `copy`, and a person can see it.
5. **`cursor` reads a whole result set and slices it** (T3's closing note). 9B replaces that one method body
   with the real `odbc` cursor when it reads every row of `BillItems`; nothing above the seam changes.

### Names this slice adds beyond the frozen registry — the corrected list

The header's list was written before Tasks 6–14 existed and is corrected in place: it named `writeArtefacts`,
which no task produces (T5 ships `ReportWriter`/`toCsv`), and omitted everything Tasks 6–14 export. The
authoritative list is the header section of the same name, and it is now read in two halves. **The
cross-slice half is already in the contracts document** — §4.18 Round 2 folded the driver port, the predicate
and row types, `createReader`/`unreadable`, `profile(reader, opts?)` + `ProfileOptions`, the scope report, the
artefact format, `RECONCILIATION_KINDS` and the barrel-as-surface into §4.13.1, so 9B may consume every one of
them today. **The rest is 9A-internal by §4.13.1's own closing sentence** — the six kinds' rule tables and row
shapes, the questions probe, the snapshot planner and its column rules, the renderer, `parseArgs`/`CliArgs`/
`main`, and the test-tier `loadCorpus` — and needs no amendment, because no slice imports it. Nothing on the
header list is waiting on a contracts edit before 9B can start.

---

## Execution handoff

**Order.** Strictly 1 → 14. Every task's test suite depends on the corpus and the seam the previous ones
built, and three of the fourteen are owner gates that can be skipped without renumbering anything.

**Branch.** One branch, `feat/9a-extraction-profiling`, off `main`. Fourteen commits, one per task, each with
the subject and trailer written into the task. Pushing to GitHub is the owner's call, not part of any task's
definition of done (§3.8, plan0A:2927).

**Prerequisite.** 0B merged — that is all (§6.3: "9A ∥ anything after 0B"). Do **not** wait for the Phase 0
exit gate; this plan's row counts size the Phase 1 and 3 load tests (spec:2267), so it is most useful early.
`@dulja/db`, `@dulja/domain`, PostgreSQL and Testcontainers are not needed by any task.

**Droppable tasks.** T3 (OD-17), T6 (OD-16) and T13 (OD-27). Dropping T3 leaves the fixture driver as the only
implementation and every other task green — but then no live byte is ever read and the slice produces nothing
about the customer's actual data, so T3 is the task to unblock first. Dropping T6 means the `mpos` schema is
never touched, which is the §2.12 default — but `ProfileOptions` is a **frozen §4.13.1 member** declared in
T6 Step 5 and exported in T6 Step 6, so an executor who drops T6 applies the fallback written into **T5
Step 6's barrel note**: declare `export interface ProfileOptions { readonly includeMpos?: boolean }` at the
top of `profile.ts`, accept the parameter and ignore it, and export it on T5's own `./profile` line. The
registry member exists either way; only the filter goes. Dropping T13 leaves the five Part VII questions unanswered and
leaves `tests/regression/legacy-024.test.ts` (1A's, `it.skip`) skipped.

**Definition of done for the slice.**

- [ ] `bun run lint && bun run lint:rules && bun run format:check && bun run typecheck && bun run test` green from the repository root.
- [ ] `bun run legacy all --fixture base --out artefacts/legacy/dev` exits 0 and writes twenty-one artefacts (scope, profile, six kinds × JSON+CSV, templates.json, four `.report` blobs, open-questions.json, index.json).
- [ ] `bun run legacy questions --fixture questions` prints five lines, each ending `verdict: owner (OD-27)`.
- [ ] `bun run legacy snapshot --fixture base --tables ACCOUNTS --out artefacts/legacy/dev-snap` exits 0, and `grep -r 'Ali Hassan' artefacts/legacy/dev-snap` finds nothing.
- [ ] `packages/db/migrations/` is unchanged and 0100 is unused: `git diff --name-only main -- packages/db/migrations | wc -l` prints `0`.
- [ ] `git status --porcelain artefacts/` prints nothing — `.gitignore` covers it and no customer data is staged.
- [ ] ADRs 0081, 0082 and 0083 exist; 0083 carries T14's amendment.
- [ ] `tests/regression/legacy-077.test.ts` contains a `describe(... — 9A)` block and whatever else was already there.
- [ ] Corrections **C1** (T7 Step 1, with T11's three one-line follow-ups), **C2** (T12), **C4** and **C5** (T14) applied. There is no C3 or C6: both were folded into Task 3, where the code they corrected is first written.
- [ ] ``grep -n '` +\|+ `' packages/importer/src/drivers/odbc.ts`` prints nothing — every SQL literal in the one file that holds statement text is unbroken (spec:100).
- [ ] The barrel is §4.13.1's list exactly. `grep -c "^export" packages/importer/src/index.ts` prints **14** (T4's seven statements, T5's two, T7's two, and one each from T11, T12 and T13 — T6 widens T5's first line rather than adding one, and T14 adds none; a statement wrapped over two lines still counts once because its continuation is indented), `grep -n "ProfileOptions" packages/importer/src/index.ts` finds it, and `grep -nE "\"\./(snapshot|mpos|drivers/sql|cli)\"|catalogue/questions" packages/importer/src/index.ts` prints nothing — the snapshot planner, the mpos group, the questions group, the renderer and the CLI stay 9A-internal.

**Handed to 9B.** The barrel `@dulja/importer` exports `LegacyReader`, `createReader`, `LegacyPredicate`,
`profile`, `ProfileReport`, `ProfileOptions`, `reconcile` and the two drivers — **§4.13.1's barrel list
exactly, no name more and none fewer** (T4 Step 4, then T5, T6, T7, T11, T12, T13; T14 adds nothing). 9B
imports nothing by a deep path and needs nothing this list omits. 9B adds `@dulja/domain` and
`@dulja/db`, replaces `OdbcLegacyDriver.cursor`'s body with the real cursor API, and reads the artefacts this
slice wrote. The three answers 9B waits on are **OD-25** (suspense treatment and the cut-over date, from
`unbalanced_vouchers.csv`), **OD-16** (from `mpos-decision.json`) and **OD-26** — none of which this plan
decides.

**Carried to the contracts document — all six items already landed in §4.18 Round 2, so this is a checklist to
verify on read, not a set of requests.** When this plan was first written the amendments were pending; they
are not any more. Before starting, confirm each row below still stands in the contracts document as described,
and if any has been reversed by a later round, follow the fallback named beside it.

*Landed in §4.18 (verify, do not re-file):*

- [ ] 1. `LegacyDriver.constraints(table): Promise<LegacyConstraint[]>` and the `LegacyConstraint` shape (9A
  T13). **In §4.13.1's code block and in the Round 2 row** that reads "The driver port `LegacyDriver` (with
  `constraints`), `LegacyConstraint` …". *If reversed:* T13's Step 2 still adds the method to this slice's own
  port and nothing outside 9A breaks.
- [ ] 2. The cross-slice half of the header's *Names this slice adds beyond the frozen registry* section — the
  predicate and row types, `SelectSpec`, `createReader(driver, declaredVersion?)`, `unreadable`,
  `profile(reader, opts?)` + `ProfileOptions`, `scope`/`ScopeReport`/`TableScope`/`DATE_COLUMN_CANDIDATES`,
  the artefact format (`ArtefactIndex`, `ArtefactEntry`, `ReportWriter`, `toCsv`), `RECONCILIATION_KINDS`,
  **and the barrel as the whole cross-slice surface**. Same Round 2 row. The other half of that list is
  9A-internal by §4.13.1's closing sentence and is not carried anywhere. *If reversed:* 9B cannot import the
  barrel and the slice stops until it is restored — there is no local workaround.
- [ ] 3. `LENDS` is **not** in the 460-table map and no slice adds it — the dossier names it in prose only,
  and `ALL_LEGACY_TABLES.size === 460` is asserted (9A T1 Step 4, T13's `SALARIES_LIVENESS_TABLES`). **In the
  Round 2 row** that also carries `NEVER_READ` and the `no-bare-db` naming rule. *If reversed:* T1's size
  assertion changes by one and T13's VII-6 evidence row changes wording; nothing else.
- [ ] 4. The reading of the card's "typed row readers for the tables named in §5.1 and §0.4": it resolves to
  §4.13.1's generic `read<T>` plus each report's own local row shape. **No per-table row interface exists in
  9A and none is invented in 9B either** until the live catalogue has been read — the column sets are the
  customer's, not the dossier's, and every value crosses the seam as text (assumption 6). **Settled in Round
  2**, and the §2.10 card's *Delivers* bullet now says "typed row **reads**". *If reversed:* 9B derives named
  shapes from a live `scope`/`profile` artefact and records the derivation in its ADR — never from the
  dossier.
- [ ] 5. **The scoping task's position.** The 9A card (§2.10) and hazard 3 (§5.3) now read "the scoping report
  is the first task that reads the owner's data: 9A Task 3; Tasks 1–2 build the driver port and the SQL
  renderer and touch no customer data." **Settled in Round 2.** ⚠️ **§2.12's OD-17 row still says "9A → Task 1
  (scoping)" and is the one cell that was not updated** — it is the architect's to correct, not this plan's,
  and until it is, §2.10, §4.18 and §5.3 are the three that agree. *If reversed:* fold `scope` and the live
  driver into Task 1 and renumber 2–14 down by two (Self-Review, *The two former divergences*).
- [ ] 6. **Target size.** The card now reads "8–10 tasks for the reports, plus one isolated task per owner
  gate (OD-16, OD-17, OD-27) — **14 as written**". **Corrected in Round 2.** *If reversed:* the only legal
  compression merges an owner gate into a working task, which hazard 6 forbids; raise it rather than execute
  it.

**Nothing else is owed to the contracts document by this slice.** Round 3 (2026-09-08) added no 9A row, and
the plan as executed adds no name to §4.13.1's barrel and touches no other shared namespace (§4.14, §4.15,
§4.16, §4.17 — all *none*; the single shared literal is `ERR_IMPORT_SOURCE_UNREADABLE`, already allocated).

