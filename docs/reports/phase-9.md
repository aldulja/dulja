# Phase 9 implementation record — Migration (9A, 9B)

**Phase 9 is implemented on branch `claude/relaxed-tesla-j04lsm` (2026-11-13/14) and has not exited.** It was built
under the owner's direction of 2026-11-13, "implement phase 9 entirely". This is a local implementation record: every
clause below says what was proved, by which test, and at what strength. It claims no merge, no staging deployment, no
Windows packaged run, no ADR acceptance and no real cut-over. Phases 0–8 have not exited either; Phase 9 was begun on
unexited phases as Phases 4–8 were.

**No live Sahlisoft byte has been read.** OD-17 (read access to the live database and its Firebird version) is open:
the live ODBC driver, the scoping run and both env-gated live cases are built and have never run against a Firebird
engine, every declared legacy source column is still `confidence: "hypothesis"` (a test pins that none is `verified`
while OD-17 is open), and every recompute formula, orphan rule, employee match strategy and personal-column rule takes
its table and column names from the dossier and the plans, not from the customer's catalogue. **The Phase 9 definition
of done is therefore met only on the local equivalent** — the committed synthetic corpora loaded into PostgreSQL 18
Testcontainers — and not on the customer's books. It closes when the cut-over is rehearsed and run against the live
database, `bun run legacy reconcile-cut-over` exits 0 on it, and the customer's accountant signs the reconciliation
(`docs/runbooks/cut-over.md`, ADR 0086).

Plans: `docs/superpowers/plans/2026-09-05-dulja-phase-9a-extraction-profiling-reconciliation.md` (Tasks 1–14) and
`docs/superpowers/plans/2026-09-05-dulja-phase-9b-loaders-cut-over.md` (Tasks 0–15). Contracts: **round 20** (9B C1–C24,
with N1–N16 under §4.13.2), gated by `scripts/check/contracts-9b-amendments.sh` in CI's `checks` job; 9A needed no
round — every cross-slice name it adds was already on §4.13.1's list. ADRs **0081–0086**, all _Proposed_. Migrations
**0101–0103** (9B's range is 0101–0104; 0104 is the range's spare and unused); **0100**, 9A's, stays reserved and
unused — the profiler writes reports, not schema. The task-by-task log — every exported name, every deviation and every
test count as each task landed — is `docs/reports/phase-9-progress.md`; the best-practice resolution of each open
question is `docs/review/2026-11-13-phase-9-decisions.md` (implementation authorization, not acceptance). The two
runbooks are `docs/runbooks/legacy-extraction.md` (9A) and `docs/runbooks/cut-over.md` (9B), with
`docs/runbooks/cut-over-suspense.md` for the accountant.

## What was built

| Slice | What | Where |
|---|---|---|
| **9A** — extraction, profiling, reconciliation reports, legacy catalogues (T1–T14) | The workspace `@dulja/importer`: the `LegacyDriver` port with a fixture driver over committed synthetic corpora and a live ODBC driver (`connectOdbc`, `redactDsn`, the native `odbc` module imported lazily); one SQL renderer over catalogue-validated identifiers and bound values (ADR 0082); `LegacyReader` verbatim from §4.13.1; `scope` and `profile`; the hashed artefact format (`ReportWriter`, `toCsv` with formula neutralisation; ADR 0083); the OD-16 `mpos` decision input; the six reconciliation reports of §5.1 — `aggregate_drift` (23 rules, 13 `not_derivable`), `unbalanced_vouchers` (OD-25's input), `orphans`, `null_poison`, `duplicate_aggregates`, `employee_mapping`; the report-template catalogue (§5.1 #9, SAH-077); the OD-27 open-question probe with `LegacyDriver.constraints`; the anonymised staging snapshot (spec:2272); the `legacy` CLI's seven report commands and its exit codes | `packages/importer/src/{legacy,drivers,reconcile,catalogue}/`, `src/{reader,scope,profile,artefacts,mpos,snapshot,cli}.ts`, `test/corpus/{base,mpos,questions}/`; ADRs 0081–0083 |
| **9B** — loaders and cut-over (T0–T15) | `legacy_ref` on `document`, `party`, `item`, `account`, `employee`, `lot` (0101); `app.import_batch`, the idempotence key with `source_hash`, UPDATE revoked from `app_rw` (0102); the loader framework (`runLoad`, `preflight`, `refResolver`, `orderLoaders`, the skip register, one transaction per page); eleven registered loaders — `unit_of_measure`, `warehouse`, `account` (links only, through the owner's account map), `party`, `item`, `lot`, `opening_balance`, `open_item`, `opening_stock`, `employee`, `employee_ytd_opening` — every ledger and movement row through `draftAndPost` → `postDocument`; `OPENING_BALANCE` (series `OB`) and `OPENING_STOCK` (series `OS`, cost **recomputed** by 3B's `costingEngine`, never imported); `3900` Opening-balance suspense; `admin.import.run` with `app.import_run` (0103), `POST/GET …/imports` and the generic `GET /v1/jobs/{jobId}`; `reconcileCutOver` and `bun run legacy reconcile-cut-over` (exit 4 when anything is unexplained); `mposLoader` written and **not** registered (OD-16); the `MATOPENS` job-partition guard (OD-27 #7); the cut-over opening added to `hr.annual_statement` at read time (the Phase 8 raise) | `packages/importer/src/load/`, `packages/db/src/import/{batch,run,gates}.ts`, `packages/db/seed/my/document-types/{OPENING_BALANCE,OPENING_STOCK}.json`, `packages/db/seed/my/chart-of-accounts/9b-cut-over.json`, `apps/api/src/routes/admin/{import,job-status}.ts`, `apps/worker/src/handlers/import-run.ts`, `packages/db/src/reports/datasets/hr.ts`, `test/corpus/{cut-over,mpos-history,matopens-partitioned}/`; ADRs 0084–0086 |

Across the phase: **0** permission codes (the import routes are gated on `admin.company.manage`, §3.6.2's company
configuration code, and the run asks every executed loader's existing write code); **4** `ERRORS` rows
(`ERR_IMPORT_SOURCE_UNREADABLE` 500, `ERR_IMPORT_DUPLICATE_SOURCE_KEY` 409, `ERR_IMPORT_UNBALANCED_SOURCE` 422,
`ERR_IMPORT_SOURCE_NOT_BOUND` 403); **2** document types (`OPENING_BALANCE`, `OPENING_STOCK` — twenty-nine in the pack),
both service-only on the generic routes; **1** chart account (`3900`, 41 → 42 applied); **0** new job names
(`admin.import.run` was already 9B's in 0B's closed `JOBS`; `JOB_NAMES` stays sixteen) and one `JOB_PROBES` entry;
**2** route modules, each with a `PROBES` key (`/v1/companies/:companyId/imports`, `/v1/jobs`); **1** new environment
variable (`LEGACY_IMPORT_TARGET`) beside `LEGACY_ODBC_DSN`, both bound to the worker alone; and the `legacy` CLI's nine
commands (`scope`, `profile`, `reconcile`, `templates`, `questions`, `snapshot`, `all`, `load`, `reconcile-cut-over`).
`hr.annual_statement` moved to `definitionVersion` 2; the dataset registry stays at 34 and `ReportCodeSchema` at 40.

**No customer figure, name or identifier is anywhere in the tree.** Every corpus row is invented; the CLI and every
artefact print no pay figure and no sensitive value; `artefacts/` is git-ignored; no DSN is ever on a command line (the
runbooks set `LEGACY_ODBC_DSN`/`LEGACY_MPOS_DSN` in the environment, because `bun run` echoes its command).

## Phase 9's definition of done (spec:2295)

> _Trial balance **and** stock valuation match the source on the cut-over date, and the difference on every recomputed
> figure is explained (§5.1); each employee's imported YTD reconciles to their last legacy payslip._

`reconcileCutOver` (`packages/importer/src/load/reconcile-cut-over.ts`, ADR 0086) is the clause computed: it reads the
frozen source through 9A's reader and Dulja through the ledger at `effective_date <= cut-over date`, `valuationAsOf` and
`listEmployeeYtdOpening`, judges every row by the rule ADR 0086 names for it, and is `ok` only when nothing is
unexplained. A row is explained when its difference is zero or when its rule names a cause whose figure, computed from
the source, equals the difference exactly — no tolerance.

| Clause | Evidence | Strength |
|---|---|---|
| **The trial balance matches the source on the cut-over date** | 9B T5: one `OPENING_BALANCE` (`OB 1`) through the posting service, one line per `balance` account at its stored net, the residue on `3900` (`packages/importer/test/load/opening-balance.test.ts`, 15 cases with the OD-25 pin and the one-shot case); 9B T7: one `OPENING_BALANCE` per open AR/AP item, `ageingTieOut` `0.0000` on `1200` and `2100` (`open-items.test.ts`). `reconcileCutOver`'s `trialBalance` section per Dulja account (`balance` agrees to the cent; `ar_control`/`ap_control` equal the legacy open items; `inventory_control` equals the recomputed valuation; `exclude` holds nothing; an unmapped balance on either side is never explained) and its `suspense` section (`reconcile-cut-over.test.ts`); `tests/invariants/cut-over-reconciliation.test.ts` reads the tree's per-period `trialBalance` as a second, independent witness (`3900` a credit of 6080.0000); SAH-003's `— 9B` block with `assertExplained`. | **Executed, Testcontainers PostgreSQL 18, over the synthetic `cut-over` corpus only.** Not against the live database (OD-17); no real cut-over date (OD-25). |
| **Stock valuation matches the source on the cut-over date** | 9B T6: `replayLegacyMovements` re-costs the legacy movement history through `costingEngine.cost`, one pool per item and warehouse, the survivors laid onto batches with `remainingLayerValue` (`recost.test.ts`, 12, pure — acceptance test 5 re-run); one `OPENING_STOCK` per warehouse per 200 lines, `valuationAsOf` 180.0000 to the cent, ledger `1300` Dr / `3900` Cr 180.0000 (`opening-stock.test.ts` — acceptance test 18 re-run through the import path: a history that overdraws is reported, never opened). `reconcileCutOver`'s `stockValuation` section re-parses `BILLITEMS` with the loader's own `map`, replays it at the company's costing method and compares per item and warehouse against `valuationAsOf`. | **Executed, over the synthetic corpus, at AVCO through the posting service.** FIFO is proved by the pure replay only. Not against a live `BillItems` (OD-17). |
| **The difference on every recomputed figure is explained (§5.1)** | `reconcileCutOver` decomposes `3900` exactly — Σ trial-balance differences − the legacy imbalance, to the cent — and `explain` matches the imbalance against the SIGNED trial-balance effects of 9A's `unbalanced_vouchers` (`netImbalance`) and `aggregate_drift` (`ACCTOTALS` debit − credit drift) by subset search. On the corpus: −6080.0000 = 2220.0000 (the recost on `1300`) − 8300.0000 (the imbalance, matched by `unbalanced_vouchers`); with a stored total drifting 50, the 8350 imbalance is matched by `aggregate_drift` 50 + `unbalanced_vouchers` 8300 and `3900` −6130 decomposes to the cent. A position the load read and reported is explained by the skip register; a position the source gained afterwards stays unexplained. `reconcile-cut-over.test.ts` (seven pure `explain` cases and the PostgreSQL cases — a control drift explained, an open item Dulja lacks refused, an unmapped legacy account, a grown stock history, an unimported material, a negative pool, a withheld YTD); `assertExplained` (every `3900` ledger row belongs to an `OPENING_BALANCE`/`OPENING_STOCK` whose line carries a description); the CLI exits 0 clean and 4 against an empty tenant naming seven rows. | **Executed over the synthetic corpus.** Every recompute formula is a `hypothesis` (9A assumption 8) and 13 of `aggregate_drift`'s 23 rules are `not_derivable`; which spelling the live `ACCTOTALS`/`VOUITEMS` use, and which key domain `VouItems.Account` holds, is OD-17's. |
| **Each employee's imported YTD reconciles to their last legacy payslip** | 9B T8: `employeeYtdOpeningLoader`'s `map` runs `assertYtdReconciles` — gross **and** net against the employee's own `PAYITEMS` rows for the cut-over date's calendar year — before 8C's `upsertEmployeeYtdOpening`; a drift is withheld and reported without a figure, and loads on the next run once the source is corrected (`employees.test.ts` — acceptance test 35 re-run: `employee_ytd` empty, `checkEmployeeYtdProjection` `[]`, `ytdFromEmployeeYtd` 36000.0000). `reconcileCutOver`'s `employeeYtd` section compares the opening Dulja holds against the payslips, keyed `YTD:<EMPID>`, with no pay figure in any row; the invariant case finds two reconciled openings. | **Executed over invented payslips.** Only gross and net load — §5.1 #11's statutory shares and PCB are not (column set unconfirmed, hazard 1). No real payroll, staff list or legacy month (OD-17, OD-23). |

### The scope sentence

| Scope item (spec:2295) | Evidence | Strength and limits |
|---|---|---|
| Items | 9B T4 `itemLoader` (`MATERIALS`, through `createItem`, `legacy_ref` the `MATCODE`), `unitLoader`; `master.test.ts`, SAH-066's `— 9B` block (`rationalOf`) | Executed. No `MATUNITS` loader (neither plan nor dossier names its reference columns, hazard 3): an imported item has only its base unit. |
| Customers and suppliers | 9B T4 `partyLoader` (`ACCOUNTS` → `party`, `ACC:<ACCID>`, its control resolved from the map); `accountLoader` links the seeded chart by the owner's map; `accounts.test.ts`, `master.test.ts`, SAH-007's and SAH-073's `— 9B` blocks | Executed. 9A spells `ACCOUNTS` unprefixed, 9B prefixed — both hypotheses (OD-17). |
| Open balances | 9B T5 (above) | Executed; the residue stands on `3900` (OD-25 default). |
| Open documents | 9B T7 `openItemLoader` — one `OPENING_BALANCE` per open legacy document, `legacy_ref` the printed number verbatim (SAH-051's second `— 9B` block: two documents sharing `INV/2025/0417` get two `OB` numbers), no revenue, expense, stock or tax account touched; allocation on day one through 4A's `draftSettlement` (ADR 0085) | Executed. Base currency only; aged from the cut-over date; a legacy credit cannot be allocated (below). |
| Batch/expiry positions | 9B T4 `lotLoader` (`MATBATCHES`, `createLot`); 9B T6 positions per batch | Executed. A batch coded `NONE` or expiring before it was made is reported, never loaded. |
| Employee master and current-tax-year YTD (§5.1 #11–#12) | 9B T8 `employeeLoader` — one party of kind `employee` plus one `employee` through `createEmployee`, sealed fields through 8A's `writeSensitive` only, a leaver terminated by UPDATE so 0093's trigger fires (acceptance test 34 re-run: the trigger is reached); 9A T11's `employee_mapping` report; `employeeYtdOpeningLoader` | Executed over invented rows. No `Accounts` row becomes a person; the 9A report's unmatched rows stay the owner's decisions. |

## Acceptance tests owned and re-run

| Test | File(s) | Slice |
|---|---|---|
| **2** projection rebuild, after the whole cut-over load (six projections, no mismatch, no unbalanced document) | `tests/invariants/projection-rebuild.test.ts` | 9B T9 |
| **5** costing — the legacy history re-costed by the engine | `packages/importer/test/load/recost.test.ts` | 9B T6 |
| **9** period lock — a cut-over date in a closed period is refused `ERR_PERIOD_NOT_OPEN`, leaving no document and no batch row | `packages/importer/test/load/opening-balance.test.ts` | 9B T5 |
| **18** negative stock through the import path | `packages/importer/test/load/opening-stock.test.ts` | 9B T6 |
| **34** termination (the trigger reached; its effects are 8C's) and **35** YTD (the opening beside an empty projection) | `packages/importer/test/load/employees.test.ts` | 9B T8 |
| **12** tenant isolation — `PROBES["/v1/companies/:companyId/imports"]` (403) and `PROBES["/v1/jobs"]` (404, a real job enqueued for the victim's real run) | `tests/invariants/tenant-isolation.test.ts`, `tests/invariants/probes.ts` | 9B T9 |
| **13** job isolation — `JOB_PROBES["admin.import.run"]` | `tests/invariants/job-isolation.test.ts` | 9B T9 |
| The Phase 9 DoD, computed | `tests/invariants/cut-over-reconciliation.test.ts` (5), `packages/importer/test/load/reconcile-cut-over.test.ts` | 9B T10 |

Regression blocks appended (no SAH file created; `tests/regression/` still holds 83): **9A** sah-077 (the template
catalogue); **9B** sah-003 (the corpus load explained), sah-007 (NULL totals refused), sah-011 (no `MATCOSTS` load; no
valueless receipt), sah-022 (`MATOPENS` job partition refused), sah-028 (no credential imported), sah-049 (a twice-held
key loaded once, a different one refused), sah-051 (legacy numbers as strings, two blocks), sah-066 (`rationalOf`) and
sah-073 (orphans in the skip register, two blocks).

## Migrations and ADRs

| Number | What | Slice |
|---|---|---|
| 0100 | **reserved and unused** (9A writes reports, not schema; §3.4.1: unused numbers stay unused) | 9A |
| 0101 | `add_legacy_ref` — nullable `legacy_ref text` and a partial, non-unique `(company_id, legacy_ref)` index on six tables | 9B T1 |
| 0102 | `create_import_batch` — forced RLS, composite FK, audit, `import_batch_natural_key`, `source_hash`, UPDATE revoked from `app_rw` | 9B T2 |
| 0103 | `create_import_run` — the run record, the lease, `import_run_one_live_per_company` (contracts round 20 C17) | 9B T9 |
| 0104 | the range's spare; unused | 9B |

Every migration has a handwritten down and passes up → down → up. `import_batch` and `import_run` are pinned whole in
`NEVER_EXPORTED` (plumbing); `legacy_ref` joins the six tables' `EXPORT_TABLES` rows.

ADRs, all **Proposed** (spec:95 — each touches security, money semantics or the data model): **0081** the Firebird
version and extraction method (its three decisions blank until the owner's scoping run, OD-17) · **0082** the legacy
reader composes SQL from catalogue-validated identifiers and bound values (one owner question) · **0083** legacy
artefacts — format, hashing and what may leave the customer's machine (two owner questions; amended at T14 and by
review finding 2) · **0084** idempotent loaders keyed on `import_batch` (decisions 1–27 across the T3 text and its T8,
T9 and two review amendments; owner questions 1–8) · **0085** the cut-over series `OB`/`OS` and opening documents that
never re-recognise revenue (three owner questions) · **0086** what "the difference on every recomputed figure is
explained" means (decisions 1–9; four owner questions). The decisions record resolves each question as implementation
authorization.

## Contracts round 20

| Amendment | What |
|---|---|
| C1 | the cut-over series are §4.14's `OB` and `OS`, not a literal `LEGACY` |
| C2 | `/v1/jobs/{jobId}` is a `RouteModule` 9B builds — **narrows** round 3's ratified 4.11.2 row (a settlement for the owner) |
| C3 | `JobPayload["admin.import.run"]`; `JOBS` unedited |
| C4 | `/v1/companies/:companyId/imports` → `importRoutes` → `admin.company.manage`; one `PROBES` key |
| C5 | `seedImportBatch(db, s, opts)` |
| C6 | `tests/invariants/support/cut-over.ts` — `cutOverFixture`, `CutOverFixture`, `loadFromCorpus`, `assertExplained`, `reconcileFor` |
| C7 | `import_batch.source_hash` |
| C8, C9, C12–C15 | six additive widenings of §4.13.2 (`sourceColumns`/`sourceKey`, `artefacts`, an async `map`, `wholeTable`, `only`, load-side `skips`), with N1–N16 beneath |
| C10 | `LEGACY_ODBC_DSN` reaches the worker container (`containerSecrets(env, "worker")`), never the api — a security widening |
| C11 | `3900` is also the `OPENING_STOCK` credit leg |
| C16 | thirteen places the 9B plan was stale against the tree |
| C17 | `app.import_run` (0103), the job-status gate as built, `ACCOUNT_MAP_TARGETS`/`SENSITIVE_TARGETS` |
| C18 | the `employee_ytd` dataset adds `app.employee_ytd_opening` at read time; round 18 B14 unchanged (supersedes round 19 item 16's last sentence) |
| C19 | review finding 1 — `LEGACY_IMPORT_TARGET`, `ERR_IMPORT_SOURCE_NOT_BOUND`, `LoadSourceFactory` takes the target |
| C20 | review finding 4 — `IMPORT_LOADER_WRITE_CODES` at the POST and at claim; the openings refuse a company that posted outside the load |
| C21 | review finding 5 — `LoadContext.heartbeat`, `renewLeased`, `renewImportRunLease` |
| C22 | review finding 7 — a busy delivery's follow-up; `supersedeStaleImportRuns` |
| C23 | review finding 8 — `AggregateRule.storedSpellings` (`AggregateSpelling`, `firstSpelling`) |
| C24 | review finding 3 — the two whole-table openings are one-shot (`refusePriorOpening`); a load-side skip is final |

## Deviations from the plans

Every one is recorded where it was made: round 20's C16 lists each place the 9B plan was stale against the tree, and
`docs/reports/phase-9-progress.md` lists each task's own. The ones a reader most needs:

- **No placeholder batch row.** 0102 revokes UPDATE from `app_rw`, so `runLoad` reads `findBatch` first, then `map`,
  `load` and `recordBatch` with the id `load` answered, one transaction per page (ADR 0084 decision 2). A key the
  source holds twice in one run loads once if identical and refuses if different (SAH-049).
- **The loaders write through the tree's services** (`createUnit`, `createWarehouse`, `createItem`, `createLot`,
  `createEmployee`, `writeSensitive`, `upsertEmployeeYtdOpening`, `postDocument`), and two legacy rows whose names give
  one Dulja code never collapse into one row (`placeByCode`).
- **`legacy_ref` carries the human code** (`MATCODE`, `BATCODE`, `ACCCODE`, `EMPNUMBER`, the printed document number),
  per 0101's column comments; the `import_batch` key stays the surrogate id.
- **One cost pool per item and warehouse**, not per lot (the engine's contract); the opening value is exact, not a
  rounded average times quantity; a batch an issue overdraws drops its whole pool, reported.
- **An open item's sign is carried by `side`**, an unknown `BILKIND` refuses, and an item whose party ages on another
  control than the map's refuses the run (ADR 0085 decision 5).
- **The YTD reconciliation is its own loader's `map`**, so a withheld opening loads once the source is corrected, and it
  compares gross and net; no pay figure or sensitive value reaches any message, artefact or log.
- **A run table** (`app.import_run`, C17) holds the account map under RLS, reports a dry run and refuses a second live
  load per company in the data layer; pg-boss's `singletonKey` was dropped. A refused run fails the run, not the job.
- **`/v1/jobs/{jobId}` is narrower than C2's text**: registered subjects only, the requester only, the gate re-checked,
  and `output` is the subject, never pg-boss's column.
- **"Explained" is decided per row by its rule** (ADR 0086), `3900` is decomposed exactly, and the stock valuation is a
  real recomputation — the plan's reconciliation compared the valuation with itself and copied the YTD onto both sides.
- **The AGENTS.md rewrite (9B T10 Step 7) was deferred to the phase close** by the lead's direction, and does not say
  the phase is complete: the plan's text assumed a live cut-over.
- **The Phase 8 raise was taken**: `hr.annual_statement` (version 2) and the `employee_ytd` dataset add the cut-over
  opening at read time (C18).

## Review (2026-11-14)

An independent review of the Phase 9 change set (`dc907e5..1ec71fd`) raised eight findings. Each was verified against
the code before it was fixed, all eight held, and each fix landed with a regression test that failed on the code before
it. The records commits are `ec3d44b` (findings 1, 4, 5, 7) and `e2e9a88` (2, 3, 6, 8).

| # | Severity | Finding | Fix | Commit | Proved by |
|---|---|---|---|---|---|
| 1 | HIGH | Any tenant could import the one configured legacy database: `LEGACY_ODBC_DSN` is process-wide in a worker that serves every tenant | `LEGACY_IMPORT_TARGET=<tenantId>:<companyId>` bound to the worker; the handler and `loadSourceFromEnv(target)` refuse every other run, and every run while unset, with `ERR_IMPORT_SOURCE_NOT_BOUND` before the source opens; the CLI must match it whenever the DSN is the environment's (ADR 0084 decision 21, C19) | `e2486ed` | `packages/importer/test/load/target.test.ts`, `cli.test.ts`, `apps/worker` import-run, `apps/edge` containers |
| 2 | HIGH | The anonymised snapshot copied prefixed personal columns (`EMPNATID`, `EMPDOB`, `EMPBANKACC`, `EMPTAXNO`, the YTD and payslip figures …) in clear | Rules are stems matched after an optional three-letter prefix; `date_of_birth` and `pay` are omitted; `PERSONAL_TABLES` fail closed — only the primary key and recognised pseudonymised columns leave (ADR 0083 amendment) | `d955b46` | `packages/importer/test/snapshot.test.ts` (+7, with a cross-check over every loader column) |
| 3 | MEDIUM-HIGH | "Reverse the opening and load again" posted a partial opening or reloaded nothing | The trial-balance opening and opening stock are **one-shot** (`refusePriorOpening`); every "reverse" remedy withdrawn; a load-side skip is final, corrected after cut-over by ordinary documents; the reconciliation explains a read-and-reported stock position by the skip register (ADR 0084 decisions 26–27, ADR 0086 decision 9, C24) | `1e52d29` | `opening-balance.test.ts`, `opening-stock.test.ts`, `reconcile-cut-over.test.ts` |
| 4 | MEDIUM | `admin.company.manage` alone posted ledger, stock and HR data through the system-principal job | `IMPORT_LOADER_WRITE_CODES`: the requester must also hold every executed loader's write code at company scope, at the POST and again at claim; `refuseForeignPostings` in `open_item` and `opening_balance` (ADR 0084 decision 22, C20) | `837bfa6` | `packages/db/test/import/gates.test.ts`, importer `registry.test.ts`, `open-items.test.ts`, `apps/api` and `apps/worker` import tests |
| 5 | MEDIUM | A load longer than the 4-hour lease ran twice and ended `failed` | A heartbeat before every page renews the claim (`renewLeased`, `renewImportRunLease`, throttled to 300 s); a superseded claim stops recording nothing (ADR 0084 decision 23, C21) | `a1eb44f` | `packages/db/test/import/run.test.ts`, `apps/worker` (+2) |
| 6 | LOW-MEDIUM | `import_batch.source_hash` held an unsalted digest of each employee's YTD gross and net | Both columns `sensitive` (presence only); ADR 0084 decision 13's sentence withdrawn by decision 25 | `ac5a78f` | `employees.test.ts` (+1) |
| 7 | LOW | A run could stay `queued` for ever and block the company | A busy delivery schedules a follow-up; the next POST supersedes a run queued and unclaimed past the lease; no new route (ADR 0084 decision 24, C22) | `45dd9b0` | `apps/worker`, `apps/api` import tests |
| 8 | LOW | `aggregate_drift` read `ACCTOTALS(ACCOUNT, DEBIT, CREDIT)` while the load spells `ACTACC/ACTDEBIT/ACTCREDIT`, so it never explained any of `3900` | `AggregateRule.storedSpellings` and `firstSpelling` (the first complete spelling present); the same for `null_poison`, `duplicate_aggregates` and `orphans`; the corpus's `VOUITEMS.ACCOUNT` carries chart codes (ADR 0086 decision 8, C23) | `b9f7872`, corpus `c0910d5` | `aggregate-drift.test.ts` (+6), `reconcile-cut-over.test.ts` (+1) |

## Security-control widenings and tightenings for review

- **C10, `LEGACY_ODBC_DSN` in the worker container** (§3.11 said CLI only): `containerSecrets(env, "worker")` passes
  it, and since the review `LEGACY_IMPORT_TARGET`, when bound — for the cut-over only (`docs/runbooks/deploy.md`); the
  api never; `LEGACY_MPOS_DSN` reaches neither.
- **The `admin.import.run` job runs as the tenant's system principal** and posts openings no person drafted; the review
  bounded it by **`IMPORT_LOADER_WRITE_CODES`** (a tightening): the requester must hold every executed loader's write
  code at company scope, at `POST …/imports` and again of `requested_by` at claim; a registered loader without a row
  fails closed.
- **`LEGACY_IMPORT_TARGET`** binds the configured source to one tenant and company (a tightening; the API does not
  refuse up front, decision 21).
- **`/v1/jobs/{jobId}`** (C2, a narrowing of round 3's ratified row): `membershipOnly()`, a registered subject, the run
  visible under RLS in the payload's company, requested by the caller, who still holds `admin.company.manage` there;
  one 404 for every other case.
- **One-shot openings** (`refusePriorOpening`) and **`refuseForeignPostings`** (tightenings): a reversal never reopens
  an opening; an opening never lands in a company that already trades; a whole re-import goes into a fresh company.
- **`OPENING_BALANCE` and `OPENING_STOCK` are service-only** on the generic document routes (create, line-replace,
  convert, settlement), as FX_REVALUATION and the `hr` types are; the generic reversal is not refused.
- **Data minimisation**: `import_batch.source_hash` carries sensitive and pay columns as presence only; the snapshot's
  personal tables fail closed; `NEVER_READ` (`USERS.PASSWORD`, `USERS.PIN`) is never selected, and no loader declares a
  password or PIN column (SAH-028).

## Owner gates and questions

- **OD-17** — open: read access to the live Sahlisoft database and its Firebird version. Nothing has read a live byte;
  ADR 0081's three decisions are blank; no column is promoted to `verified`. The promotion procedure, the env-gated live
  pre-flight case and the spelling question it settles (9A unprefixed, 9B prefixed) are in
  `docs/owner/od-17-live-database.md`.
- **OD-16** — open, default built (start clean): `profile` drops the `mpos` tables unless `--include-mpos`; `--mpos`
  writes `mpos-decision.json` with `answer: null`; `mposLoader` is written and refuses, and is not registered.
- **OD-25** — open: the cut-over date and the treatment of `3900`. Default: a rehearsal on the last day of an open
  period, the residue stands, the import writes no clearing JOURNAL (pinned)
  (`docs/owner/od-25-suspense-and-cut-over-date.md`, `docs/runbooks/cut-over-suspense.md`).
- **OD-26** — open (Part VII #4, `Users.Password`): default stands either way — no credential imported, every user
  invited fresh with MFA (`docs/owner/od-26-legacy-passwords.md`).
- **OD-27** — open (Part VII #6, #7, #8, #9, #13): the probe ships, every verdict is null; #7 is asked at load time and
  fails closed (`MATOPENS` job partition refused); #13 — an empty `EMPLOYEES` loads nothing, an absent one fails
  pre-flight naming the `--only` remedy (`docs/decisions/od-27-9b-part-vii-7-and-13.md`). 7B T12 and 7C T12 (the
  template mapping) stay dropped: 9A's catalogue is built but has not run against the live database.
- **OD-23** — open (Phase 8's): the YTD clause has never met a real payslip, staff list or legacy month.
- **ADRs 0081–0086**, all Proposed, and round 20's **C2** settlement and **C10** widening.

## Known limits, recorded and not fixed

- **Every legacy column is a hypothesis** and pre-flight against the live catalogue (OD-17) is what corrects a wrong
  spelling; 9A's reports and 9B's loaders spell several tables differently (both in the `cut-over` corpus).
- **Open items age from the cut-over date** (every item `current` on day one; the legacy date is in the description),
  are loaded in **base currency only** at rate 1, and a legacy credit open item cannot be allocated until a refund or
  set-off rule exists (ADR 0085 questions 1–3; ADR 0047 question 5).
- **Only gross and net YTD load**; statutory shares and PCB do not, so the annual statement's scheme columns omit the
  legacy months' contributions and the first Dulja run's PCB does not see the opening.
- **A re-run detects no change of a sensitive value or a YTD figure alone** (both hashed as presence only).
- **A staging snapshot of a personal table carries only its primary key and pseudonymised columns**; an HR rehearsal
  runs against the live source in a rehearsal company.
- **The openings are one-shot and a load-side skip is final**: a reported stock position is corrected after cut-over by
  a STOCK_COUNT; a whole re-import goes into a fresh company (ADR 0084 owner question 8).
- **A dry run's counts are an upper bound** (it writes no `import_batch` row, so a fresh tenant needs a real
  `--only account` first), and a dry run never reaches `load`, so it does not ask OD-27 #7.
- **An API run's artefacts** (`skips.csv`, `load-summary.json`) stay on the worker's disk; no route serves them (ADR 0084
  question 5); a CLI run is not listed by `GET …/imports`.
- **Every imported warehouse lands in BRANCH `HQ`**, and `branch_id` is immutable; no `MATUNITS` loader exists; a legacy
  IsEmployee account's balance opens without the employee dimension.
- **A refused run shows `state: completed` with `output.status: failed`** on `/v1/jobs/{jobId}` (ADR 0084 question 4).
- **`scripts/lint/rules/dependency-rule.ts`'s token scanner stalls** on `#6` inside a regex literal that also holds an
  escaped `\/` (9B T6); recorded, not fixed.
- **The runtime image** copies `packages/importer` but carries neither the `odbc` native binding nor a Firebird ODBC
  driver — OD-17's deployment work.

## Known environment failures

Two failures recur on this container and are not Phase 9's: `tests/invariants/zero-code-document-type.test.ts`'s
"prints: a PDF in each direction" (test 15 — this Chromium hands the hyphen to the text layer as a Private Use glyph),
and `packages/db/test/reports/7b-report-indexes.test.ts`'s "a timezone date companion compiles to bounds on its instant,
and the planner seeks them" (`shift.opened_on`: on the PostgreSQL 18.7 image the planner keeps
`shift_company_opened_idx`'s `company_id` seek and filters `opened_at`), which fails identically on the pre-Phase-9 tree.

**Fixed after the final run (2026-11-14).** The second was not an environment quirk but a real report defect. Under
RLS, PostgreSQL 18.7 will not use a qual holding a SubPlan as an index condition on the row-secured table, and
`DatasetColumn.localDateOf`'s bounds inlined the company-timezone subquery, so every report run over `shift`,
`needs_attention` and `attendance_event` filtered the instant instead of seeking it (as superuser, without RLS, the
same statement seeks; with the zone bound as a value it seeks under RLS too). `localTimezoneFor`
(`packages/db/src/reports/query.ts`) now reads the zone once on the run's own transaction and `datasetWhere` binds
it as a value; the index case resolves it the same way and passes, as do `packages/db`'s report and HR suites
(571, five skips), the report tie-outs and POS-report invariants, `apps/api`'s report and POS routes and
`apps/worker`.

## Verification

Final run on the tree after the review fixes (head `9b04cff`, 2026-11-14, Linux, Node 22, Bun 1.4, PostgreSQL 18.7
Testcontainers):

| Check | Result |
|---|---|
| `bun run typecheck` | 15/15 workspaces |
| `bun run lint`, `bun run lint:rules` | clean; 11 rules, 1,534 files, 0 violations |
| `bun run format:check` | clean |
| `scripts/check/*.sh` | all 18 gates pass |
| `packages/importer` | 357 passed, 2 skipped (the two OD-17 live cases) in 32 files |
| `packages/db` | 2,420 passed, 5 skipped, **1 failed** (the PostgreSQL 18.7 planner case above) in 242 files |
| `apps/api` | 1,083 passed in 110 files |
| `apps/worker` | 165 passed in 23 files, plus its two Bun cases |
| `tests` | 1,012 passed, 5 skipped, **1 failed** (test 15's PDF hyphens, above) in 146 files |
| `bun run e2e` | 32/33 in the full run; the one failure, `reports.spec.ts` in `en` (the period lookup empty when read), passed in the first full run and then 6/6 on three re-runs of that spec; Phase 9 changes neither the back office nor the e2e specs |
| domain · contracts · sync · POS · i18n · UI · backoffice · edge · desktop · infra | 424 (3 skipped) · 69 · 58 · 252 · 41 · 22 · 289 · 49 · 54 · 25 |
| `bun run build` | the back-office, desktop and POS builds succeed |

Every failure above also fails, or flakes, without Phase 9's changes. No Phase 9 test is skipped except the two
`LEGACY_ODBC_DSN`-gated live cases.

**Not verified:** any live read (OD-17) — the ODBC driver, the scoping run, the snapshot and the cut-over against a
Firebird engine; the native `odbc` binding, not built in this environment; a real cut-over, its date, its `3900` figure
and the customer's sign-off (OD-25); a real payroll or payslip (OD-23); a run on Windows, where the owner extracts; a
built runtime image and a deployed worker with a real binding (OD-19–OD-21); and any staging re-seed.
