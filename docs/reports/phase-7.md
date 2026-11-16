# Phase 7 implementation record — Reporting (7A, 7B, 7C)

**Phase 7 is implemented on branch `claude/nice-edison-xuwfih` (2026-11-05), completed on 2026-11-06, and has not exited.** This is a
local implementation record: every clause below says what was proved, by which test, and at what strength.
It claims no merge, no staging deployment, no Windows packaged run and no ADR acceptance. Phases 0–6 have not
exited either; Phase 7 was begun on unexited phases under the owner's standing direction to work in phase order
and choose best-practice defaults for missing inputs (2026-10-02, 2026-10-22), as Phases 4–6 were (contracts
round 15, A16 item 11).

Plans: `docs/superpowers/plans/2026-09-05-dulja-phase-7a-report-engine.md`, `…-phase-7b-accounting-inventory-reports.md`
and `…-phase-7c-pos-ar-ap-reports-tenant-export.md`. Contracts: the 7A amendments inline in §4.11/§4.16/§4.18
round 3, **round 14** (7B, A1–A18) and **round 15** (7C, A1–A17), each with an executable gate
(`scripts/check/contracts-7b-amendments.sh`, `contracts-7c-amendments.sh`, both in CI's `checks` job). ADRs
**0065–0070**, all _Proposed_, implemented ahead of approval as 0054–0064 were. Migrations **0074–0079**, all six
of Phase 7's range used.

## What was built

| Slice | What | Where |
|---|---|---|
| **7A** — the engine (T1–T14; T15 built 2026-11-06 on the default baseline) | `app.report_definition` (0074), `app.saved_view` and `app.report_run` (0075), `accounting.report.export` granted to `auditor` (0076); the `ReportDefinition` JSON Schema (`urn:dulja:report-definition:1`, `additionalProperties: false` throughout), its generated type and `validateReportDefinition` over the closed dataset and permission sets; **25** named datasets (no `pdc`, OD-09); `renderReport` (sort, group level by level, subtotals, totals in `Decimal`, logical column order with `dir` carrying direction) and the CSV, XLSX and Chromium-PDF renderers; the balance-sheet and P&L layouts, per BRANCH; the `reporting.render` job; `POST …/reports/{code}/runs`, the run resource and its download; clone-and-edit definitions and saved views; the `reports` seed sub-pack | `packages/domain/src/reports/`, `packages/db/src/reports/`, `apps/worker/src/{reports,jobs/report-render.ts}`, `apps/api/src/{reports,routes/accounting/report-*.ts}`; ADRs 0065–0067 |
| **7B** — accounting and inventory catalogue (T0–T14; T12 dropped, T13 no screen) | **22** definitions in `packages/db/seed/my/reports/7b/` (17 new, 5 re-expressed at `definitionVersion` 2 beside their 1B/3D JSON routes); the executed tie-out harness `tests/invariants/support/reports.ts`; migration **0077**, fourteen report-filter indexes (twenty-one since the 2026-11-06 remediation, below), and the SAH-070 EXPLAIN gate | ADR 0068; `tests/invariants/report-tie-out.test.ts`; `packages/db/test/reports/7b-*.test.ts` |
| **7C** — AR/AP, POS, cross-module, tenant export (T0–T10, T14; T11–T12 dropped, T13 built 2026-11-06 on the default baseline) | the `shift`, `till_event` and `needs_attention` datasets (registry closes at **28**); **10** definitions in `…/reports/7c/` (7 new, 3 re-expressed at version 2: `accounting.ageing`, `pos.z_report`, `pos.sales_by_cashier`); `app.export_job` (0078) and `admin.data.export` granted to `auditor` (0079); `EXPORT_TABLES` / `NEVER_EXPORTED` classifying every `app` table; the deterministic `.tar.gz` (`schema.json`, `manifest.json`, CSV and newline-delimited JSON per table, attachments); the `admin.export.run` job; four export routes, requester-only | `packages/db/src/{reports/datasets/pos.ts,export/}`, `apps/worker/src/jobs/export-run.ts`, `apps/api/src/{export,routes/admin/exports.ts}`, `packages/contracts/src/admin/export.ts`; ADRs 0069–0070 |

`ReportCodeSchema` holds **32** codes — exactly the 32 shipped seed files (pinned both ways in
`tests/invariants/report-catalogue-pins.test.ts`). §4.16.1's register has 41 rows: these 32, the dropped
`accounting.pdc_register` and 8D's eight HR codes.

## Phase 7's definition of done (spec:2293)

> _A user clones and edits a report without a release; every report's numbers tie to the ledger._

| Clause | Evidence | Strength |
|---|---|---|
| **A user clones and edits a report without a release** | `apps/api/test/routes/accounting/report-definitions.test.ts` ("A USER CLONES AND EDITS A REPORT WITHOUT A RELEASE"): clone a core definition through the API, edit the clone's columns, run it — the run resolves to the clone and renders the edited layout — and the core row is byte-unchanged in the API and the table. A clone takes `max(version)+1` under an advisory lock; a core row refuses an in-place edit. | **API level, real PostgreSQL 18;** since 2026-11-06 also **through the designer in a browser** (`tests/e2e/reports.spec.ts`, EN/LTR and AR/RTL, against the local stack: clone a core report, retitle it, a refused width corrected, save, archive). The screen is on the plans' default baseline; legacy keyboard parity is unproven (`docs/ui/od-24-phase-7a.md`). |
| **Every report's numbers tie to the ledger — 7B's 22** | `tests/invariants/report-tie-out.test.ts` executes every 7B definition's declared `tieOut` (7 `ledger_sum`, 10 `projection`, 5 `none`) against one fixture carrying every chain, and fails by name on a code with no case; the five re-expressions carry parity cases against `trialBalance`, `accountLedger`, `stockOnHand`, `valuationAsOf` and `salesByItem` (`packages/db/test/reports/7b-reexpress-*.test.ts`), and the owning slices' tests re-run unchanged. | **Executed, Testcontainers PostgreSQL 18.** A `ledger_sum` ties to an independent ledger query; a `projection` to the stored projection or table the report reads (or `valuationAsOf`); a `none` (a list with no money total — the two auditor views, the price list, the promotion register, the expiry list) to an **independent row witness**, which proves the rows and not a ledger figure (ADR 0068). |
| **Every report's numbers tie to the ledger — 7C's 10** | `tests/invariants/report-tie-out-7c.test.ts` (7C T14) executes every shipped 7C definition's `tieOut` — five `ledger_sum` (party statement, sales by cashier, sales by branch, branch P&L, tax return view), four `projection` (`party_ageing`, `allocation`, `bank_statement_line`, `shift`) and `pos.needs_attention`'s `none` with its witness — with the group tests' own parameters (`paramsFor`, `posParams`, `crossParams`, now shared in `support/reports-7c.ts`). Parity: `accounting.ageing` against 4B's `agedBalance` bucket for bucket; `pos.z_report` against 6D's `zReport` field by field for every shift of the day (with an OD-10 paid-out that moves neither a count nor net sales); `pos.sales_by_cashier` against `salesByCashier` per cashier and branch. | **Executed, Testcontainers PostgreSQL 18.** Same three strengths. The allocation register and unreconciled items tie to their stored tables, because an allocation posts nothing and a statement line is not a ledger row (round 15, A3). |
| **The re-expressions moved no number** (§4.16.1 "re-expresses") | Re-run unchanged at 7C T14: `tests/invariants/pos-shift-reconciliation.test.ts` (test 21) and `report-tie-out.test.ts`; `packages/db/test/ar-ap/ageing.test.ts` and all of `packages/db/test/reports/` (24 files, 249 cases); `apps/api/test/routes/accounting/ageing-report.test.ts`, `routes/pos/shifts.test.ts` and the 7C group test (47 cases). Zero edits to any owning slice's test. | Executed. |

### The scope sentence

| Scope item (spec:2293) | Evidence | Strength and limits |
|---|---|---|
| Report definition format | ADR 0065; `packages/domain/test/reports/definition.test.ts`, `report-type.test.ts`; `tests/regression/sah-077.test.ts` (7A and 7C blocks: committed text, no blob, no SQL-shaped value, a registered dataset id as the only source) | Pure and structural. A definition can never carry SQL text (test 27): a dataset column is a literal SQL fragment authored in `packages/db/src/reports/datasets/*.ts`. |
| Server-side render (PDF/XLSX/CSV) | ADR 0066; `apps/worker/test/reports/{render,renderers,pdf}.test.ts` — test 23 read back from real PDF bytes through `pdfText` (labels, Arabic numerals, Hijri dates, column order); `apps/api/test/routes/accounting/report-runs.test.ts` | Executed with this container's Chromium. **Chromium is the only PDF engine** (ADR 0016's set; Typst refused by name). The worker image still ships no Chromium and no Arabic-capable font, so a deployed worker cannot render a PDF yet; CSV and XLSX need neither. |
| ~60 parameterised core reports | 32 definitions; §4.16.1 counts _parameterised outputs_ (`accounting.document_register` covers thirty document types through one parameter; round 14, A15) | Catalogue as registered; 8D adds eight HR codes. |
| Saved views | ADR 0067; `packages/db/test/reports/saved-view*.test.ts`; §3.5.4's DELETE pin re-asserted unchanged (archive, never delete) | Executed. The run screen chooses, saves and archives views (7A T15, 2026-11-06). |
| Financial-statement layouts | `packages/domain/test/reports/statement.test.ts`, `packages/db/test/reports/statement-tie-out.test.ts` (balance-sheet net + P&L net = 0 to the cent; rows equal the trial balance), the per-BRANCH read summed in SQL; `accounting.branch_profit_and_loss` **is** `statementDefinition("profit_and_loss", …, { perBranch: true })` by deep equality | Executed. Since the 2026-11-06 remediation the sections print as their bilingual heading in accounting order and the header prints the period's `YYYY-MM` code (below). |
| Tenant data export in open formats (§4.3 — v1) | ADRs 0069–0070; `packages/db/test/export/{archive,run,store,tables}.test.ts`, `apps/worker/test/handlers/export-run.test.ts`, `apps/api/test/routes/admin/{exports,exports-gates}.test.ts`, `tests/invariants/export-audit.test.ts` | Executed against PostgreSQL and the in-memory `ObjectStore`. Deterministic within the limits ADR 0069 states (below). |

### 7C's own definition of done, as the tree has it

The plan's nine clauses, with round 15's A16 item 1 applied (OD-09 = not built):

1. **Datasets:** 28, not 29 — 7A's 25 plus `shift`, `till_event`, `needs_attention`, each a named read with a
   two-tenant case (`packages/db/test/reports/7c-datasets.test.ts`; the literal pin in `datasets.test.ts`).
2. **Ten** codes, not eleven, seeded from `…/reports/7c/`, validated against the live sets, field coverage proved
   (group tests and the roll-up).
3. **Nine and one**, executed (above).
4. 4B's ageing tie-out and 6D's test 21 re-run unchanged and green (above).
5. `POST …/exports` produces the archive with `schema.json`, `manifest.json`, one CSV and one JSON per included
   table and every attachment the requester may see (`run.test.ts`); the same job run twice gives the same
   `sha256` (`run.test.ts`, `archive.test.ts`).
6. A table whose gate the requester lacks is **absent and named** in `manifest.excluded` (`run.test.ts`,
   `tables.test.ts`, `exports-gates.test.ts`) — 8A's `employee_sensitive` plugs in with two edits to
   `tables.ts` and no exporter change.
7. A branch-narrowed holder of `admin.data.export` gets **403** on all four routes (`exports.test.ts`,
   `exports-gates.test.ts`), and a table gate held at one branch does not admit its table.
8. Every export is audited: the request under the requester, the claim and completion under the system
   principal; the chain verifies afterwards; the strict body has no opt-out (`export-audit.test.ts`, test 13).
9. `AGENTS.md`'s **Current phase** names Phase 7 — as **implemented, not exited** (the plan's "complete" text is
   not used: the phase gates below are open) — and `sah-077` and `sah-085` each carry a 7C block.

### 7A's and 7B's slice tables

7A's eleven DoD rows (the plan's "Definition of done for this slice") all have their named evidence in the tree:
the clone clause above; text format (`definition.test.ts`, `sah-077`); no SQL text (`datasets.test.ts`,
`sah-069`'s 7A block, `bun run lint:rules`); `ERR_REPORT_DATASET_UNKNOWN` (`datasets.test.ts`); render and status
resource (`render.test.ts`, `report-runs.test.ts`); RTL/LTR parity (`pdf.test.ts`, `sah-085`'s 7A block); saved
views archive (`saved-view.test.ts`, `privileges.test.ts`); statements per BRANCH (`statement*.test.ts`); the
export code and its auditor grant (`permission-catalogue.test.ts`, `roles-seed.test.ts`,
`apps/api/test/reports/authorise.test.ts`); two-tenant isolation per table; `lintSchema` zero violations.
7B's four rows: the eighteen totalled definitions and the five `none` ones are executed by its roll-up (the
plan said four `none`; `inventory.expiry_list` joined them because the `lot` dataset carries no quantity,
round 14 A3); the five re-expressions re-run their owners' tests and carry parity cases; the SAH-070 gate
(`packages/db/test/reports/7b-report-indexes.test.ts`) judges every filter of all thirty-two definitions.

## Deviations from the plans

Each is recorded where the plans say: round 14's A18 and round 15's A16 list every place a plan was stale
against the tree, and each task commit names its own. The ones a reader most needs:

- **OD-09 not built:** no `pdc` dataset, no `accounting.pdc_register`, no `pdc` tie-out branch; 25 + 3 datasets,
  32 codes (`docs/decisions/od-09-7c-pdc-register.md`).
- **7A:** the Typst adapter and `reportToTypstSource` are not built (ADR 0016's engine set is Chromium only);
  `renderReport` groups level by level and formats dates in UTC (the plan's flat partition and local-time dates
  were wrong); validation faults throw `ReportDefinitionError` so `errors[]` reach the wire; the runs `POST`
  needed `markExportRequestGate` to boot (below); `seedReportDefinition` and the boolean filter bind through
  `::text::jsonb` / `::text::boolean` (postgres.js double-encodes a bare `::jsonb` and sends `"true"` to a
  boolean parameter as false — the second found by 7C T1, A16 item 12); a `count` total no longer parses its
  column's values (found by 7B).
- **7B:** re-expression keeps the owning slice's JSON route and adds a parity case (A2 ⚠️); report headers use
  only 7A's placeholders; the two auditor views take `fromTime`/`toTime` text parameters because a `date`
  parameter cannot filter a timestamp column; `inventory.stock_on_hand` runs need `hideQuantity: "0"` to hide
  the zero rows 3D's function hides; the master lists render their validity windows because the filter grammar
  cannot express "is null".
- **7C:** column `width` minimum 8, not 0 (A16 item 14); total sort orders via declared tie-break columns
  (items 14, 16); no version-1 rows for the three re-expressed codes (item 17); the POS windows are the run date
  ± 1 day in the company's timezone (items 3, 19); the Z-report definition carries totals and counts, not 6D's
  tender and cash-control lines (item 18); the export marker carries one code per route and an export answers
  only its requester (item 24); `paramsFor`/`posParams`/`crossParams` moved into the harness at T14 so the
  roll-up and the group tests read one table.

## Defects found and fixed during the close-out

- **The runtime image could not run Phase 7's code.** 7A T10 made `apps/worker` import `@dulja/i18n` and 7A T4's
  validator imports `packages/domain/report-definition.schema.json` at module load; `infra/Dockerfile` copied
  neither, and `infra/test/dockerfile.test.ts` (which walks the entrypoints' import graph) failed four cases. No
  earlier Phase 7 run had included the `infra` workspace. Fixed in `infra/Dockerfile` (the i18n manifest, source,
  catalogues and `node_modules`; the schema file) and the test's forbidden list no longer names
  `packages/i18n`, which the worker now legitimately imports. Proved by replaying the runtime stage's file set (Verification, below); a `docker build` could not install packages in this container.
- **7B's migration pin** asserted that nothing occupied 0078–0079 and had been red since 7C T5; it now asserts the
  two numbers hold exactly 7C's migrations.

## Remediation of the recorded limits (2026-11-06)

The owner directed on 2026-11-06: "make sure phase 7 is implemented entirely; if you have any question choose the
best suggestion and complete the phase; make it ready to merge." Three recorded limits were closed, one commit
each (subject suffix `[7 remediation]`):

- **The seven unserved report filters are served.** Migration 0077 — applied to no deployed database — was
  amended in place (the 0044–0050 precedent) with `document (company_id, party_id, effective_date)`,
  `allocation (company_id, party_id)`, `shift (company_id, opened_at)`, `shift (company_id, opened_principal_id,
  opened_at)`, `needs_attention (company_id, branch_id, created_at)` (non-partial), `needs_attention (company_id,
  created_at)` and `tax_transaction (company_id, fiscal_period_id)`, with their Drizzle mirrors and down lines.
  The two timezone date companions are sargable: `DatasetColumn.localDateOf` compiles `eq`/`ne`/`lt`/`lte`/`gt`/
  `gte` on `shift.opened_on` and `needs_attention.created_on` to bounds on `opened_at`/`created_at`, the local
  day's first instant computed so that a DST change repeating midnight (America/Havana) still starts the day
  correctly. `packages/db/test/reports/7c-datasets.test.ts` proves the rows identical to the timezone
  expression's for every operator, one microsecond either side of local midnight, in Asia/Kuala_Lumpur and on
  Havana's skipped and repeated midnights. The SAH-070 gate's `UNSERVED` list is gone: a new selective filter
  with no seekable index fails it, and a new case requires every date-over-timestamptz field to compile to bounds
  the planner puts in an `Index Cond`. Contracts round 14 and round 15 A17 record it.
- **The ageing prints its buckets in 4B's order.** `party_ageing.bucket_rank` (0–4, 0048's vocabulary order) and
  `accounting.ageing` sorts on it. A sort key no longer has to be a displayed column (ADR 0065 amendment, a
  proposal; `assertDefinitionFields` still refuses a key the dataset lacks). 4B parity and the projection
  tie-out hold.
- **Statements print their sections by heading, in accounting order, and the period's code.** Rows carry
  `section_rank` (asset, liability, equity; revenue, expense) and `section_label` in the run's language
  (`statementSectionFields`; `rowsForDefinition` takes the run's `lang`); the layout prints and groups on the
  label and sorts on the rank (branch code first per BRANCH). The three statement seed files are regenerated
  from `statementDefinition`. `reportDisplayParameters` resolves each `period` parameter to its `YYYY-MM` code
  for the header, which the `reporting.render` handler uses — so the eight definitions whose header names
  `{fiscalPeriodId}` print the code, not a uuid.

## Security-control widenings and recorded limits

- **R7 widening (ADR 0067 decision 6, extended by ADR 0070 decision 4):** `markExportRequestGate(handler, code)` /
  `EXPORT_REQUEST_ROUTES` (`apps/api/src/middleware/require-permission.ts`) admit a `mutating: false` export code
  on an unsafe method, **one code per route**: `accounting.report.export` on `POST …/reports/{code}/runs` and
  `admin.data.export` on `POST …/exports`. `assertRouteGates` refuses any other export code on a listed route.
- **Branch-restricted principals are refused report runs.** `requireReportRead` asks
  `app.actor_has(code, company, null)`, which is false for a branch-restricted assignment, so a branch manager
  cannot run any report even for their own branch. Fail-closed by design (runs execute as the system principal,
  so RLS's `branch_isolation` would not bound them; A16 item 5); widening it is a run-path change.
- **Report layout limits:** headers support only 7A's placeholders (`{title}`, `{code}`, `{rowCount}`,
  `{generatedAt}` and the run's parameters — a `period` parameter printed as its `YYYY-MM` code, every other one
  raw); a `date` parameter cannot filter a timestamp column; `inventory.stock_on_hand` runs need
  `hideQuantity: "0"`; the definition-driven Z-report has no tender or
  cash-control lines (6D's route keeps them); `pos.sales_by_cashier` attributes a shift to its opener, 6D's
  over/short to its closer (they agree only while one cashier opens and closes a shift).
- **Render limits:** Chromium is the only PDF engine, and the runtime image carries no Chromium and no
  Arabic-capable font yet (OD-20; the decisions record recommends Debian's `chromium` and `fonts-noto-core`).
- **Gate limits (2026-11-06 review, ADR 0065 amendment):** some cost-derived figures stay readable under
  `inventory.stock.read`, because shipped definitions (3D's and 4A's design) print them there —
  `inventory_movement.value`, `item_profitability.cogs_base`/`margin_base` and the count register's `base_total`;
  within one admitted gate a clone may still change a parameter's options, bounded since the review by
  `DATASET_ROW_BOUNDS`.
- **Lease limit (ADR 0067 amendment):** a worker that dies inside the final delivery's claim statement leaves that
  run or export row as it was.
- **Export limits (ADR 0069):** an export is not one snapshot across tables (`withTenant` is `read committed`);
  `tables/audit_log.*` grows with the export's own audited writes, so two exports of unchanged books differ there
  for a holder of `admin.audit_log.read`; the deflate stream is zlib's, so the digest is reproducible by the same
  build; `audit_log` is tenant-wide, so a multi-company tenant's export carries every company's trail.

## Owner gates and questions

- **OD-24:** 7A T15 (the report list, run screen and designer) and 7C T13 (the export screen) were built on
  2026-11-06 on the plans' default baseline under the owner's direction of that day, verified in EN/LTR and AR/RTL,
  with legacy keyboard parity unproven (`docs/ui/od-24-phase-7a.md`, `docs/ui/od-24-phase-7c.md`); 7B T13 ships no
  screen by design (`docs/ui/od-24-phase-7b.md`). OD-24 still blocks seven earlier screen tasks.
- **OD-27:** 7B T12 and 7C T12, the legacy-template mappings, are dropped — 9A has not run
  (`docs/decisions/od-27-7b-template-mapping.md`, `od-27-7c-template-mapping.md`).
- **OD-09:** 7C T11 dropped (`docs/decisions/od-09-7c-pdc-register.md`).
- **ADRs 0065–0070**, all Proposed. 0069 asks three questions (the gate table, the `NEVER_EXPORTED` list and the
  classify-every-table rule, whether `audit_log` narrows to the company) and 0070 three (the request-time gate
  snapshot, requester-only visibility, `admin.data.export` on a POST through R7's widening). On 2026-11-06 all six were resolved
  as recommended, as implementation authorization rather than acceptance (`docs/review/2026-11-06-phase-7-decisions.md`).
- **Contracts proposals:** round 14 **A2 ⚠️** (re-expression keeps the JSON route) and round 15 **A11 ⚠️** (a
  permission-seed task ships its route reference in the same commit).
- **Raises carried forward:** `withTenant`'s isolation level for a consistent export;
  7B's Task 12 Verify path (`docs/legacy/9a-artefacts/` is not 9A's output root); document-event paging passes to
  8D (7B A16).

## Verification

Run on 2026-11-05 against this branch at the 7C T14 commits (Linux, Bun 1.4, Node 22, PostgreSQL 18 Testcontainers,
the container's Chromium), every workspace's own `test` script run in sequence, uncached:

| Workspace | Result |
|---|---|
| `packages/db` | 1,954 passed in 199 files |
| `apps/api` | 892 passed in 93 files |
| `apps/worker` | 101 passed in 17 files, plus its 2 Bun health cases |
| `tests` | 873 passed, 5 skipped, **1 failed** in 137 files — test 15's PDF (`invariants/zero-code-document-type.test.ts`, "prints: a PDF in each direction"): the extracted text reads `CR1` for `CR-1`, this container's Chromium dropping the hyphen; the known pre-existing failure, not Phase 7's |
| `packages/domain` | 378 in 37 files |
| `packages/contracts` | 69 |
| `packages/sync` | 58 |
| `packages/i18n` | 41 |
| `packages/ui` | 22 |
| `apps/pos` | 251 |
| `apps/backoffice` | 194 |
| `apps/edge` | 45 |
| `apps/desktop` | 54 |
| `infra` | 25 — after the runtime-image fix; the same run before it failed four `dockerfile.test.ts` cases |
| `bun run e2e` | 21/21 |

Against the baseline after 7B (`packages/db` 1,873, `apps/api` 860, `apps/worker` 97, domain 378, contracts 66,
`tests` 841 passed): 7C added 81 database, 32 API, 4 worker, 3 contracts and 32 acceptance cases.

Static checks on the finished tree: `bun run typecheck` 14/14 workspaces, `bun run lint`, `bun run lint:rules`
(11 rules, 0 violations), `bun run format:check`, all thirteen `scripts/check/*.sh` gates (the twelve contract gates
including `contracts-7b-amendments.sh` and `contracts-7c-amendments.sh`, and `no-authority-literals.sh`),
`bun run --cwd apps/api openapi:generate` with no diff to `packages/contracts/openapi.json`, and the back-office
(`vite build`), desktop (`build`) and POS (`build:pos`) builds.

The 7C T14 re-run matrix, run unchanged before the full run: `tests` `invariants/pos-shift-reconciliation` and
`invariants/report-tie-out*` (3 files, 49 cases); `packages/db` `test/ar-ap/ageing` and `test/reports/` (24 files,
249); `apps/api` `routes/accounting/ageing-report`, `routes/pos/shifts` and `routes/reports/7c-pos-cross-module`
(3 files, 47).

**The runtime image.** `docker build` could not install packages in this container (no network inside the build),
so the image was not built. The runtime stage's `COPY` set was instead replayed into a directory over this
workspace's installed packages: from the pre-fix Dockerfile the API stops at
`Cannot find module '../../report-definition.schema.json'` and the worker at `Cannot find module '@dulja/i18n'`; from
the fixed one the worker reaches its database connection (`ECONNREFUSED` against an unreachable URL) and the API
runs without a load error. `--production`'s dependency set is checked by `infra/test/dockerfile.test.ts`, not by
this replay.

**Not verified:** a built image, staging and deployment (OD-19–OD-21), the Windows packaged run (CI's `desktop`
job), a PDF render inside the worker image, and any screen (OD-24).

## 2026-11-06: completion and code review

Under the owner's direction of 2026-11-06 ("make sure phase 7 is implemented entirely; if you have any question
choose the best suggestion and complete the phase; make it ready to merge"), the branch gained, after the 7C T14
close-out (`f53ac06`): the decisions record `docs/review/2026-11-06-phase-7-decisions.md` (`948697a`), which
resolves every open Phase 7 question as **implementation authorization, not acceptance** — every ADR stays
_Proposed_ and A2/A11 stay ⚠️; the remediation of three recorded limits (`e395eb1`..`cd55102`, "Remediation of the
recorded limits" above); the two OD-24 screens; and a full code review of the Phase 7 change set in two rounds,
every fix in its own commit (subject suffix `[7 review]`) with a regression test that fails on the tree before it.

### The two screens (OD-24, built on the authorized default baseline)

| Task | What | Evidence |
|---|---|---|
| 7A T15 (`55c08a9`) | The report list (`/reports`), the run screen (`/reports/$code`: a form generated from the definition's parameters, saved views, the three formats, status polling, downloads, the run history) and the designer (`/reports/$code/design`: core read-only, Clone, edit the presentational members, the API's `errors[]` beside their fields, archive) | `apps/backoffice/test/{reports,report-designer}.test.tsx`; `tests/e2e/reports.spec.ts` (EN/LTR and AR/RTL, by keyboard) |
| 7C T13 (`e539bee`) | The tenant export screen (`/admin/exports`): request (format and attachments toggle), follow, verify the digest, download | `apps/backoffice/test/routes/admin/exports.test.tsx`; `tests/e2e/exports.spec.ts` (EN/LTR and AR/RTL) |

`bun run e2e` went from 21 to 25 (each new spec runs in both locales). No legacy screenshots, operator description
or key map exist, so **legacy keyboard parity is unproven**; the gate records (`docs/ui/od-24-phase-7a.md`,
`od-24-phase-7c.md`) list every default taken, including OD-24 item 4 (a user may change everything
presentational the definition format carries, never the dataset, filters, parameters, permission or tie-out).

### Code review, first round

| Finding | Fix | Regression test |
|---|---|---|
| A definition could widen the data its runs read: a run executes as the system principal, and a clone could re-gate any dataset on any code (e.g. `accounting.audit_log` with its before/after images on a weaker code) | `DATASET_READ_CODES` (the closed codes each dataset admits) and `assertDatasetGate` inside `assertDefinitionFields`, at save and seed; a code's versions keep one `dataset.source`; the writer must hold the new permission and every permission the code's versions carry (`ERR_RBAC_FORBIDDEN`); the `audit_log` dataset no longer serves `before`/`after` (`e60761e`; ADR 0065 amendment, round 15 A16 item 26) | `packages/db/test/reports/{definition-gates,definition-store,datasets}.test.ts`, `apps/api/test/routes/accounting/report-definitions.test.ts` |
| `GET …/report-runs` was gated on `accounting.report.export` alone, so an export-only principal listed every run | `listReportRuns` keeps a run only when the caller holds its definition's permission (`99e83de`) | `packages/db/test/reports/run-store.test.ts`, `apps/api/test/routes/accounting/report-runs.test.ts` |
| A worker that died after claiming left its run or export `running` forever | A claim is a lease: `started_at` (report run) and `attempts` (both) in `0075`/`0078`, amended in place; a stale claim is reclaimed, `attempts` fences complete/fail, the claim past three fails the row; jobs enqueued with the lease's options (`d30fed8`; ADR 0067 amendment) | `packages/db/test/{reports/report-run,export-job}.test.ts`, `apps/worker/test/{reports/render,handlers/export-run}.test.ts`, the run and export route tests |
| The export held an `app_rw` transaction open across every object-store get | `runExport` reads gates, schema, tables and attachment rows in one short transaction and fetches the bytes after it commits (`5c0462c`; ADR 0069 amendment) | `packages/db/test/export/run.test.ts`, `apps/worker/test/handlers/export-run.test.ts`, `apps/api/test/routes/admin/exports{,-gates}.test.ts` |
| A dataset run over 100,000 rows rendered short with totals that looked complete | Both branches of `rowsForDefinition` read one row past the cap and refuse with `ERR_VALIDATION_FAILED` (`0910088`) | `packages/db/test/reports/statement-tie-out.test.ts` |
| Report CSV cells starting `=`, `+`, `-`, `@`, TAB or CR reached Excel as formulas | Such a cell and header is prefixed `'` (OWASP); a numeric column's plain decimal stays raw; XLSX already stores strings; the tenant export's CSV stays raw data (`772b9d6`; ADR 0069 note) | `packages/domain/test/reports/render.test.ts`, `apps/worker/test/reports/renderers.test.ts` |
| `failExportJob` stored its reason uncapped and the handlers duplicated `failureDetail` | One helper, capped at 2,000 characters (`dde77ff`) | `apps/worker/test/jobs/failure.test.ts`, `handlers/export-run.test.ts` |
| The run screen's master dropdowns read one page of 1,000 and offered no typed id | `lookup` follows `next_cursor` to the end, capped at ten pages, then a typed-id field (`8682294`) | `apps/backoffice/test/reports.test.tsx` |

### Code review, second round

| Finding | Fix | Regression test |
|---|---|---|
| 1. A delivery that found a live claim threw and spent a pg-boss retry; the budget ended before an export's 3,600 s lease, leaving the row `running` with no job left | Such a delivery enqueues one follow-up after the remaining lease (singleton per claim) and returns; an exhausted claim ends `failed` (`b493df2`) | `apps/worker/test/{reports/render,handlers/export-run}.test.ts`, `packages/db/test/jobs/lease.test.ts` |
| 2. Object keys were deterministic per row, so a superseded worker could overwrite its successor's artefact and break the digest | Keys carry the claim number; the row stores the completing claim's key; a superseded worker deletes its own object (`0b3fc60`) | `apps/worker/test/{reports/render,handlers/export-run}.test.ts`, `packages/db/test/{export/store,reports/report-run,reports/run-store}.test.ts` |
| 3. The export shipped every `report_run` row behind `accounting.report.export`, re-opening the run-list leak | `report_run` is gated on `admin.audit_log.read`; its lease columns are pinned in `NEVER_EXPORTED` (`ac8603a`; ADR 0069) | `packages/db/test/export/tables.test.ts` |
| 4. A clone of the count register under `inventory.stock.read` could change `countTypes` to financial documents | `DATASET_ROW_BOUNDS`: `document` under `inventory.stock.read` reads only inventory document types (`a97aeb6`) | `packages/db/test/reports/dataset-row-bounds.test.ts` |
| 5. `document_line.cost` was readable under `accounting.report.read` | A column may declare `requires`; `document_line.cost`, `cost_layer`/`cost_consumption` `unit_cost`/`value` and `stock_valuation.value` require `inventory.cost.read` (`a7c8af1`) | `packages/db/test/reports/definition-gates.test.ts` |
| 6. The run list called `app.actor_has` once per candidate row | The caller's read codes are resolved once per call and compared as a bound array (`01f4802`) | `packages/db/test/reports/run-store.test.ts` |
| 7. The run and export stores duplicated the claim ladder, fence and failure cap | `packages/db/src/jobs/lease.ts` (`claimLeased`, `leaseFence`, `leaseJobOptions`, `FAILURE_DETAIL_MAX`) (`6607b43`) | `packages/db/test/jobs/lease.test.ts`, `apps/worker/test/jobs/failure.test.ts` |
| 8. The dataset gate was enforced only when a definition was written | `rowsForDefinition` runs `assertDatasetGate` before reading; `POST …/reports/{code}/runs` refuses 400 with no run or job (`40527eb`) | `apps/worker/test/reports/render.test.ts`, `apps/api/test/routes/accounting/report-runs.test.ts` |

Contracts round 15 A16 records the review: item 26 (`e60761e`, the definition gate), item 27 (`fdfb186`, the
first round's run and export changes) and item 28 (`a72fa50`, the second round, with its amendments to ADRs 0065,
0067 and 0069). Every amendment is a proposal, like the ADR it amends.

**Limits the review recorded rather than changed:** some cost-derived figures stay readable under
`inventory.stock.read` because shipped definitions print them there by 3D's and 4A's design
(`inventory_movement.value`, `item_profitability.cogs_base`/`margin_base`, the count register's `base_total`);
within one admitted gate a clone may still change a parameter's options, now bounded by the row bound; a worker
that dies inside the final delivery's claim statement leaves that row as it was; the export is not one snapshot
across tables. Branch-restricted principals stay refused report runs (fail-closed), and the runtime image still
lacks Chromium and an Arabic-capable font: the build environment's proxy refused the Debian mirror, so the change
could be neither built nor run (recommended for OD-20: `chromium`, `fonts-noto-core`,
`CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` and an explicit sandbox decision).

**Outside this branch:** the review also found that 6D's `verifyCashEvent` (`packages/db/src/sync/till-cash.ts`)
checks that a cash event's cashier is a live cashier of the branch holding `pos.shift.own` but not that they are
the shift's own cashier. It is a Phase 6 defect, recorded in `AGENTS.md`'s known defects and not fixed here.
Fixed on 2026-11-07 on `claude/admiring-ritchie-vaurt7`, server and till both (ADR 0064's 2026-11-07 amendment).

### Final verification (head `a72fa50`)

Run on 2026-11-06 (Linux, Bun 1.4, Node 22, PostgreSQL 18 Testcontainers, the container's Chromium), every
workspace's own `test` script:

| Workspace | Result | Since 2026-11-05 |
|---|---|---|
| `packages/db` | 1,979 passed in 202 files | +25, +3 files |
| `apps/api` | 895 passed in 93 files | +3 |
| `apps/worker` | 119 passed in 18 files, plus its 2 Bun health cases | +18, +1 file |
| `tests` | 873 passed, 5 skipped, **1 failed** in 137 files — test 15's PDF hyphen, the known pre-existing failure | unchanged |
| `bun run e2e` | 25/25 | +4 |
| `packages/domain` | 382 | +4 |
| `apps/backoffice` | 226 | +32 |
| contracts, sync, POS, i18n, UI, edge, desktop, infra | 69, 58, 251, 41, 22, 45, 54, 25 | unchanged |

Static checks: `bun run typecheck` 14/14, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations),
`bun run format:check`, all thirteen `scripts/check/*.sh` gates, and `openapi.json` regenerated with no diff; the
back-office, desktop and POS builds pass.

**Not verified:** the Windows packaged run (CI's `desktop` job), staging and deployment (OD-19–OD-21), a built
Docker image, a PDF render inside the runtime image, and the screens' parity with the legacy screens (OD-24).
