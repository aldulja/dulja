# Phase 9 implementation progress log

On 2026-11-13 the owner directed: "implement phase 9 entirely." Phase 9 is two slices — **9A** (extraction,
profiling, reconciliation reports, legacy catalogues; `docs/superpowers/plans/2026-09-05-dulja-phase-9a-extraction-profiling-reconciliation.md`)
and **9B** (loaders and cut-over; `docs/superpowers/plans/2026-09-05-dulja-phase-9b-loaders-cut-over.md`). This log
records, per task group, what was built (files, exported names, migrations), every deviation from the plan text
and why, and the verification run. The open questions each group resolved are in
`docs/review/2026-11-13-phase-9-decisions.md`. The plans were written on 2026-09-05; where their text disagrees
with the tree as Phases 0–8 left it, the tree wins and the deviation is recorded here.

## 9A T1–T4 (2026-11-13)

### Built

- **T1** — the workspace `packages/importer` (`@dulja/importer`; `package.json`, `tsconfig.json`, `vitest.config.ts`;
  dependencies `decimal.js` and `odbc` added with `bun add`, no workspace dependency). `src/legacy/types.ts`
  (`LegacyScalar`, `LegacyRow`, `LegacyColumnKind`, `LegacyColumn`, `SelectSpec`, `LegacyDriver`, `unreadable`),
  `src/legacy/predicate.ts` (`LegacyPredicate`), `src/legacy/modules.ts` (`LEGACY_MODULES`, `LegacyModule`,
  `ALL_LEGACY_TABLES`, `moduleOf` — the dossier's 460 tables in seventeen modules, checked list by list against
  Appendix A), `src/drivers/fixture.ts` (`FixtureLegacyDriver`, `LegacyCorpus`, `readCorpus`), the committed
  synthetic corpus `test/corpus/base/` (`catalog.json`, `ACCOUNTS`, `VOUCHERS`, `VOUITEMS`) and
  `test/support/corpus.ts` (`loadCorpus`). Root: the `legacy` script and `artefacts/` in `.gitignore`; CI's `checks`
  job gains `--filter=@dulja/importer`.
- **T2** — `evaluatePredicate` and `predicateColumns` in `predicate.ts`; `src/drivers/sql.ts` (`RenderedStatement`,
  `CAST_WIDTH`, `quoteIdent`, `renderSelect`, `renderCount`, `renderMinMax`); the fixture driver evaluates `where`.
  ADR 0082 (**Proposed**).
- **T3** — `src/drivers/odbc.ts` (`OdbcOptions`, `OdbcConnection`, `OdbcLegacyDriver`, `connectOdbc`, `redactDsn`),
  `src/scope.ts` (`scope`, `ScopeReport`, `TableScope`, `DATE_COLUMN_CANDIDATES`), `src/cli.ts` (`parseArgs`,
  `CliArgs`, exported `main(argv)`, the `scope` command). ADR 0081 (**Proposed**, its decisions blank until OD-17).
- **T4** — `src/reader.ts` (`LegacyReader`, verbatim from §4.13.1; `createReader`), the barrel `src/index.ts`, and
  `ERR_IMPORT_SOURCE_UNREADABLE` (500) in `packages/contracts/src/errors.ts`, pinned in
  `packages/contracts/test/contracts.test.ts`.

No migration (0100 stays reserved and unused); no route, permission, job or screen.

### Deviations from the plan text

Each is a row in `docs/review/2026-11-13-phase-9-decisions.md`.

- The fixture driver orders and ranges by the column's kind (numeric by value with `decimal.js`, NULLs first), not
  by `localeCompare` over the text, so it agrees with the live driver's native `order by`/`min`/`max`; ADR 0082's
  consequence is corrected to say so. Predicate comparisons stay textual, as written.
- One on-disk corpus reader, `readCorpus(dir)`, shared by `loadCorpus` and the CLI's `--fixture` (the plan wrote it
  twice). `columns`/`keyColumns`/`count`/`minMax` are `async`, so a missing table is a rejection, which the plan's
  own `rejects.toThrow` assertion needs (its `Promise.resolve(this.table(…))` threw synchronously).
- The narrowing `predicate.op === "and" || predicate.op === "or"` does not narrow under the tree's TypeScript 7;
  `"operands" in predicate` does.
- `cli.ts`'s first line in the plan (`/* … packages/*/src/cli.ts … */`) closes its own comment; replaced by a line
  comment, the `.oxlintrc.json` override already granting `no-console`.
- The root script is `bun run packages/importer/src/cli.ts` (not `--cwd packages/importer`), so `artefacts/` lands
  in the repository root.
- Corrections C2 (blob as base64) and C5 (`main` exported behind `import.meta.main`) are applied in T3, where the
  code is first written; Tasks 12 and 14 have nothing to change there.
- ADR 0082 is **Proposed**, not _Accepted_ (security, spec:95).
- Assumption 11 is stale: `reader.ts` is no longer on `no-sql-concat`'s `UNSAFE_ALLOW` (the Phase 0 main-branch
  review removed it) and needs no entry. `scripts/lint/lint.test.ts`'s stale-entry example moves off that path.
- Hardenings, each tested: empty `and`/`or` and empty `in` refused; `bigint` refused with `number`; a missing native
  `odbc` binding is `ERR_IMPORT_SOURCE_UNREADABLE` (exit 3) naming `bun pm trust odbc`; a row file without a
  catalogue entry is refused; a blank `--firebird-version` falls back to the probe.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4)

- `bun run --cwd packages/importer test`: 32 passed, 1 skipped (the live OD-17 case; `LEGACY_ODBC_DSN` unset), in 5
  files — `fixture-driver` 6, `sql` 11, `scope` 4, `odbc` 6 + 1 skipped, `reader` 5.
- `bun run --cwd packages/contracts test`: 69. `scripts/lint/lint.test.ts`, `tests/regression/sah-036`, `sah-083`,
  `sah-084`, `tests/lint/*`, `tests/invariants/lint-rules` and `type-resolution`: all pass.
- `bun run typecheck` (turbo): 15/15 workspaces — the fourteen and `@dulja/importer`. `bun run lint`,
  `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`, the seventeen `scripts/check/*.sh` gates,
  and a regenerated `openapi.json` with no diff.
- `bun run legacy scope --fixture base --out artefacts/legacy/dev` prints `engine: WI-V2.5.9.27139 Firebird 2.5`,
  `tables: 3 read, 3 in the shipped map, 0 unexpected`, `rows: 9`, `wrote: artefacts/legacy/dev/scope.json`, exit 0;
  `--fixture nosuch` and a missing DSN exit 2; a DSN with no native binding exits 3.
- **Not verified:** the live driver against any Firebird engine (OD-17), and the native `odbc` binding, which is
  not built in this environment.

## 9A T5–T8 (2026-11-13)

### Built

- **T5** — `src/artefacts.ts` (`ReportWriter`, `toCsv`, `ArtefactEntry`, `ArtefactIndex`): every report as JSON and
  a BOM'd RFC 4180 CRLF CSV, each hashed with sha256 over exactly the bytes written, and `index.json` written last,
  listing itself with `bytes: 0` and `sha256: ""` (the file on disk ≡ `finish()`'s return value; a second `finish()`
  returns the same index). `src/profile.ts` (`profile`, `ProfileReport`, §4.13.1 verbatim): Part VII #1, all
  seventeen modules answered, `dateRange` omitted (never null-filled) for a table with no date column. The CLI's
  `profile` command writes `profile.json`, `profile.csv` (`table,module,rows,date_min,date_max`) and `index.json`.
  ADR 0083 (**Proposed**). Barrel: `profile`, `ProfileReport`, `ReportWriter`, `toCsv`, `ArtefactEntry`,
  `ArtefactIndex`.
- **T6 (OD-16, ⚠️ open)** — `src/mpos.ts` (`MPOS_MODULE_IDS`, `isMposTable`, `mposDecision`,
  `MposDecisionReport`; 9A-internal, not in the barrel) and the second corpus `test/corpus/mpos/` (`POSTICKETS`,
  `POSENTRIES`). `profile(reader, opts?)` takes `ProfileOptions { includeMpos? }` and filters the shipped map's
  `mposstandard`/`mpossystem` tables out by default (the §2.12 default, start clean); `--include-mpos` keeps them.
  `scope` prints `mpos: not read (OD-16 default: start clean)` unless `--mpos-dsn` is passed, which opens a second
  ODBC connection and writes `mpos-decision.json` — the numbers, the question verbatim, `answer: null`. Barrel:
  `ProfileOptions`.
- **T7** — `src/legacy/aggregates.ts` (`AGGREGATE_RULES` — 23 rules, 13 `not_derivable` —, `AggregateRule`,
  `AggregateConfidence`), `src/reconcile/probe.ts` (`hasColumns`), `src/reconcile/aggregate-drift.ts`
  (`aggregateDrift`, `READ_BATCH` = 5 000), `src/reconcile/index.ts` (`reconcile`, `RECONCILIATION_KINDS`,
  `ReconciliationReport`, §4.13.1 verbatim). The base corpus gains `ACCTOTALS` (account 10 drifts 300 vs 350) and
  `ACCOBJECTS` (no `(1, 11)` row). CLI: `reconcile [--kind all|<kind>]` writes `<kind>.json`, `<kind>.csv` and
  `index.json`; an unknown `--kind` exits 2 before the source is opened. Barrel: `reconcile`, `RECONCILIATION_KINDS`,
  `ReconciliationReport`, `AGGREGATE_RULES`, `AggregateRule`, `AggregateConfidence`.
- **T8** — `src/reconcile/unbalanced-vouchers.ts` (`unbalancedVouchers`, `SUSPENSE_QUESTION`; 9A-internal) and the
  dispatcher's second case: per voucher the signed `debit − credit`, its header date, its line count and accounts;
  the summary's population totals (absolute and net), the largest by magnitude, the date range, and the question
  verbatim. Input to OD-25 (9B's gate), no treatment proposed.

No migration, route, permission, job, error code or screen.

### Deviations from the plan text

Each is a row in `docs/review/2026-11-13-phase-9-decisions.md`.

- ADR 0083 is **Proposed**, not _Accepted_ (credentials and personal data leaving the owner's machine — security,
  spec:95); it gains two owner questions.
- `toCsv` neutralises formula cells (`=`, `+`, `-`, `@`, tab, CR lead → `'` prefix), the 7A/8C rule, except a plain
  signed decimal; the plan's CSV did not. The plan's two CSV expectations are unchanged.
- `ReportWriter` refuses an absolute artefact name, one that climbs out with `..`, and `index.json` itself
  (`ERR_IMPORT_SOURCE_UNREADABLE`). T12 writes names derived from legacy data.
- Correction C1 is applied to `profile.test.ts` and `mpos-scope.test.ts` where each is first written (T5, T6) and to
  `fixture-driver`, `reader` and `scope` at T7, as scheduled. `scope.test.ts`'s third case also pinned
  `totalRows` 9, which C1's text missed; it now equals the unbroken corpus's own total.
- `hasColumns` reads with a contradiction predicate (`c is null and c is not null`), so a successful probe returns
  no row; the plan's `batch: 1` read would, on the live driver (which reads a result set whole before slicing it),
  transfer the entire table — twice per rule, twenty times for `aggregate_drift`.
- The dispatcher's not-yet-implemented branch raises `unreadable(...)`, not a hand-written `new Error("ERR_…")`.
  Until Tasks 9–11 land, `reconcile --kind all` (the default) writes the first two kinds and then exits 3 on
  `orphans`; name a kind.
- Unbalanced vouchers sort numerically by key (`1|9` before `1|10`), not by plain `localeCompare`.
- The `--mpos-dsn` and `--dsn` connections share one `odbcOptions` helper (the `exactOptionalPropertyTypes`-safe
  form `openDriver` already used); the plan passed `firebirdVersion: undefined`, which does not compile.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4)

- `bun run --cwd packages/importer test`: 60 passed, 1 skipped (the live OD-17 case), in 9 files — `fixture-driver`
  6, `sql` 11, `scope` 4, `odbc` 6 + 1 skipped, `reader` 5, `profile` 10, `mpos-scope` 4, `aggregate-drift` 9,
  `unbalanced-vouchers` 5.
- `bun run --cwd packages/contracts test` 69; `tests` `invariants/lint-rules`, `invariants/type-resolution`,
  `lint/*`, `regression/sah-036` 77; `scripts/lint` 12.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`,
  and the seventeen `scripts/check/*.sh` gates. No route or schema changed, so `openapi.json` is untouched.
- Against the corpus: `bun run legacy profile --fixture base` → `tables: 3`, `modules in use: standard`, three
  artefacts; `legacy scope --fixture base` ends `mpos: not read (OD-16 default: start clean)`; `legacy reconcile
  --kind aggregate_drift` → `22 findings — rules=23 compared=6 drifting=1 missingStoredRows=2 notDerivable=13
  sourceAbsent=6`; `--kind unbalanced_vouchers` → `1 findings — status=compared vouchers=2 unbalanced=1 …`;
  `--kind bogus` exits 2; `--mpos-dsn` without a native binding exits 3.
- **Not verified:** any live read (OD-17), the `--mpos-dsn` path against a real POS database (OD-16), and the
  recompute formulae themselves, which stay `hypothesis` until the live database confirms them (assumption 8).
  For T14's runbook: `bun run` echoes its whole command line, so a DSN passed as `--dsn`/`--mpos-dsn` on the
  command line is printed with its password; the main DSN can come from `LEGACY_ODBC_DSN` instead, the POS DSN
  only from the flag.

## 9A T9–T11 (2026-11-13)

### Built

- **T9** — `src/reconcile/orphans.ts` (`ORPHAN_RULES` — nine rules, `OrphanRule`, `orphans`; 9A-internal) and the
  dispatcher's `orphans` case. The base corpus gains `JOBS` (one row, `ID` 1), so `VOUITEMS` row `(1,2,1)`'s
  `JOB = 99` is the corpus's one orphan; `0` and the empty string are "not set". Per rule: distinct dangling values
  with the rows that carry each, `clean` when it ran and found none, `source_absent` when its tables or columns are
  not in this database. Summary: `rules`, `skipped`, `clean`, `orphanedValues`, `orphanedRows`, `note`.
- **T10** — `src/reconcile/null-poison.ts` (`NULL_POISON_TARGETS`, `NullPoisonTarget`, `nullPoison`) and
  `src/reconcile/duplicate-aggregates.ts` (`DUPLICATE_TARGETS`, `DuplicateTarget`, `duplicateAggregates`), both
  9A-internal, and their two cases. The corpus: `ACCTOTALS` account 11's `CREDIT` is NULL (SAH-011) and
  `MATOBJECTS` (no key columns, SAH-049) holds key `5|1` twice and one NULL `QNT`. `null_poison` is one row per
  target column in declared order (`poisoned`/`clean`/`source_absent`), four poisoned columns and four NULLs in the
  corpus; `duplicate_aggregates` one row per duplicated key, else one `clean` or `source_absent` row per table, each
  carrying `tableRows`. `aggregate-drift.test.ts` moves `drifting` to `"2"` and its rows to 23, and gains a case
  pinning the NULL figure's drift row (`stored "0.0000"`, `difference "-100.0000"`).
- **T11** — `src/reconcile/employee-mapping.ts` (`EmployeeMatchStatus`, `EmployeeMatchStrategy`,
  `EMPLOYEE_MATCH_STRATEGIES`, `normaliseLegacyName`, `employeeMapping`) and the sixth case; the dispatcher's
  `default` is deleted, so the switch is total over §4.13.1's union (removing a case is TS2366 — checked).
  The barrel gains the employee-mapping group (`EMPLOYEE_MATCH_STRATEGIES`, `employeeMapping`,
  `normaliseLegacyName` by value; the two types), pinned in `reader.test.ts`. The CLI's unknown-`--kind` refusal is
  the plan's one line (`config: unknown --kind employees — expected all or one of …`, exit 2), and `--kind all`
  (the default) now writes all six kinds and exits 0. The corpus gains `EMPLOYEES` (three rows) and accounts 13 and
  14, flagged `IsEmployee`; `profile.test.ts`/`scope.test.ts` move `ACCOUNTS` to 5 rows and `salaries` to true.
  ADR 0083 gains a consequence on the report's personal data.

No migration, route, permission, job, error code or screen.

### Deviations from the plan text

Each is a row in `docs/review/2026-11-13-phase-9-decisions.md`.

- `orphans` writes a `clean` row for a rule that ran and found nothing (summary `clean`), and
  `duplicate_aggregates` a `clean` row per table without a duplicate plus `tableRows` on every row (summary `clean`,
  `sourceAbsent`). The plan's test titles ask for a clean result to be visible, not merely absent; its code wrote no
  row. The plan's exact duplicate row gains `tableRows: 3`.
- Dangling values and duplicated keys sort numerically (`1|9` before `1|10`), T8's rule, not by plain
  `localeCompare`.
- `nullPoison` probes each column on its own, then counts a table's present columns in one pass, instead of one
  full read per column (five scans of BillItems on the live driver).
- `employeeMapping` applies the account column to every HR row before any name (the plan's single loop let an
  earlier HR row take, by name, an account a later row declares); links an account declared by two HR rows to
  neither; matches a name only when it is unique on both sides among the rows still open, so two HR rows
  normalising onto one account are both `ambiguous_name` — which the plan's own strategy derivation says and its
  code did not do (the second row became `hr_only`); never matches an empty name; and emits matched pairs, then
  unmatched HR rows, then unmatched accounts, as the plan's comment orders them.
- Every employee-mapping row carries `declaredAccount` (`EMPLOYEES.ACCOUNT` as `SITE|ID`), so an HR row pointing
  at an account not flagged `IsEmployee` keeps the link; the plan's exact rows gain the field.
- Keys are `SITE|ID`, not the plan's `SITE/ID`: every other reconciliation report writes `|`, and Excel — where
  ADR 0083 says the owner opens the CSV — reads `1/12` as a date.
- Data minimisation (ADR 0083): `ACCOUNTS` is read with the bound predicate `ISEMPLOYEE = '1'`, so unflagged
  accounts' names are never read (the plan read every account's name and filtered in memory).
- Edits the plan missed: `profile.test.ts`'s "present but empty" case empties `EMPLOYEES` too (else `salaries`
  is true from it), and `fixture-driver.test.ts`'s numeric-order case now builds its own `ACCOUNTS` rows
  (`10, 100, 9, 11`) instead of appending to the corpus's, whose maximum T11 moved.
- `EMPLOYEE_MATCH_STRATEGIES` is typed as a two-element tuple (assignable to the plan's
  `readonly EmployeeMatchStrategy[]`) so its members index without a cast.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4)

- `bun run --cwd packages/importer test`: 87 passed, 1 skipped (the live OD-17 case), in 13 files — adding
  `orphans` 5, `null-poison` 3, `duplicate-aggregates` 3, `employee-mapping` 15 (three for `normaliseLegacyName`,
  ten for the report, two driving `main`), and `aggregate-drift` 10. Each new suite failed first on the missing
  module.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`,
  the seventeen `scripts/check/*.sh` gates; `tests` `invariants/lint-rules`, `type-resolution`,
  `logical-properties` and `lint/*` 78. No route or schema changed, so `openapi.json` is untouched.
- Against the corpus: `bun run legacy reconcile --fixture base` (`--kind all`) writes the six kinds' JSON and CSV
  and `index.json` and exits 0 — `orphans` `rules=9 skipped=6 clean=2 orphanedValues=1 orphanedRows=1`,
  `null_poison` `columns=25 poisonedColumns=4 poisonedValues=4`, `duplicate_aggregates` `tables=5 clean=2
  sourceAbsent=2 duplicatedKeys=1 excessRows=1`, `employee_mapping` `hrRows=3 accountRows=3 matchedByAccount=1
  matchedByName=1 hrOnly=1 accountOnly=1 ambiguousNames=0`; `--kind employees` exits 2 with the plan's message. A
  test asserts no corpus name reaches the console.
- **Not verified:** any live read (OD-17). Every rule's table and column names (`JOBS`, `COSTCENTRES`, `JOURNAL`,
  `MATCOSTS`, `ACCCURTOTALS`, `MATQUANTITY`, `LOCALDEBIT`, `ACTUALCOST`, `EMPLOYEES.ACCOUNT`, `ISEMPLOYEE`'s value
  `1` …) come from the dossier and the plan, not the customer's catalogue; a name that is wrong reads as
  `source_absent` (T9, T10) or, for `employee_mapping`, as an `ERR_IMPORT_SOURCE_UNREADABLE` refusal naming the
  column, never as a silent zero. Both employee match strategies stay `hypothesis`.

## 9A T12–T14 (2026-11-13)

### Built

- **T12** — `src/catalogue/templates.ts` (`TemplateGroup`, `TemplateEntry`, `TemplateCatalogue`,
  `TEMPLATE_GROUP_RULES`, `classifyTemplate`, `templateStem`, `catalogueTemplates`; 9A-internal beside them
  `TemplateColumns`, `locateTemplates`, `templateColumns`): every `REPORTS` blob written verbatim to
  `templates/<name>.report`, hashed, grouped by the dossier's §4.4 rules, with the §7.10 near-duplicate families
  marked; the name, owner and blob columns discovered from the catalogue. `ReportWriter.write` creates the
  artefact's subdirectory. The base corpus gains `REPORTS` (five rows, blobs as base64 with `0xFF` bytes, one
  null). CLI: `templates` writes `templates.json`, `templates.csv`, the blobs and `index.json`. Barrel: the
  template-catalogue group (§4.13.1). `tests/package.json` gains `@dulja/importer`; `tests/regression/sah-077.test.ts`
  gains its `— 9A` block below the untouched 7A and 7C blocks.
- **T13 (OD-27, ⚠️ open)** — `LegacyConstraint` and `LegacyDriver.constraints(table)` in `src/legacy/types.ts`,
  implemented by `FixtureLegacyDriver` (declared constraints, plus the PRIMARY KEY its `keyColumns` imply; corpus
  tables may carry `constraints`) and `OdbcLegacyDriver` (one uninterpolated statement over
  `RDB$RELATION_CONSTRAINTS`/`RDB$INDEX_SEGMENTS`/`RDB$REF_CONSTRAINTS`, the table bound). `src/catalogue/questions.ts`
  (`answerOpenQuestions`, `CONSTRAINT_CLAIMS`, `SALARIES_LIVENESS_TABLES`, `ConstraintClaim`, `OpenQuestionAnswer`,
  `OpenQuestionReport`, `QuestionId`, `QuestionStatus`; all 9A-internal): evidence for Part VII #6, #7, #8, #9 and
  #13, every `verdict` null, every answer naming OD-27. The third corpus `test/corpus/questions/` (ten tables). CLI:
  `questions` writes `open-questions.json`, `open-questions.csv` and `index.json` and prints five lines, each ending
  `verdict: owner (OD-27)`. Barrel: `type LegacyConstraint`.
- **T14** — `src/snapshot.ts` (`PersonalKind`, `PersonalColumnRule`, `PERSONAL_COLUMN_RULES`, `NEVER_READ`,
  `SnapshotColumnPlan`, `SnapshotTable`, `SnapshotResult`, `planSnapshot`, `pseudonymise`, `snapshot`; all
  9A-internal): spec:2272's anonymised extract — one CSV per table under `snapshot/`, `snapshot-plan.json`/`.csv`
  beside it, HMAC pseudonyms truncated to the replaced value's length under a per-run salt written nowhere,
  `USERS.PASSWORD`/`USERS.PIN` never selected. CLI: `snapshot [--tables A,B]` and `all` (scope, profile, the six
  reconciliations, templates, questions — and `mpos-decision.json` under `--mpos`/`--mpos-dsn` — into one directory
  and one index); the new `--mpos` switch reads `LEGACY_MPOS_DSN`; the usage line lists all seven commands; the
  command branches share one writer per report (`writeProfile`, `writeReconcile`, `writeTemplates`,
  `writeQuestions`, `readMpos`). ADR 0083 amended (C4, "as built", no DSN on a command line).
  `docs/runbooks/legacy-extraction.md`. The barrel is unchanged.

No migration (0100 stays reserved and unused), route, permission, job, error code or screen; no contracts round —
every cross-slice name T12–T14 add is already on §4.13.1's list.

### Deviations from the plan text

Each is a row in `docs/review/2026-11-13-phase-9-decisions.md`.

- Corrections C2 (T12) and C5 (T14) were already applied at T3; T12 and T14 changed nothing in `odbc.ts`'s
  `coerce` or `cli.ts`'s tail. `cli.test.ts` calls `main([...])` rather than assigning `process.argv`.
- Every non-empty template row gets its own file (a stem taken case-insensitively gains `~<n>`; a Windows device
  name gains `_`), so per-user copies of one name no longer overwrite each other; `nearDuplicateOf` excludes a row
  by position, so identical names point at each other.
- One template-column discovery, `locateTemplates`, answers `{ refused }` instead of throwing; the catalogue
  throws on it, the #8/#9 probes and `all` report it. The plan's #8 and #9 read `NAME`/`USERNAME`/`DEFINITION`
  by name.
- `open-questions.csv` names the answer's text `answer_finding` (#6's evidence `finding` overwrote it), carries
  `owner_decision` and an empty `verdict` on every row, and writes one bare row for an answer with no evidence.
  #6 joins a natural key with `|` (the plan's `""` let `1,11` and `11,1` collide).
- `all` writes the union of the five commands' artefacts — `profile.csv`, `templates.csv` and
  `open-questions.csv` too — so 24 on the base corpus, not the plan's 21; it honours `--include-mpos` and `--mpos`;
  and it prints `templates: skipped — <reason>` rather than aborting when `REPORTS` is absent or has no blob column.
- The snapshot counts, and never reads, a table whose every column is omitted (an empty column list is "every
  column" to a driver, so the plan's code would have selected `USERS.PASSWORD` from a `USERS` holding only the
  two denied columns); `--tables` is trimmed and upper-cased.
- `--mpos` reads `LEGACY_MPOS_DSN` (the variable alone reads nothing), refining T6's "no fallback" so that no
  password has to sit on a command line `bun run` echoes.
- The plan's slice DoD expects `grep -c "^export" packages/importer/src/index.ts` to print 14; it prints 13,
  because `LegacyConstraint` joined T4's `export type { … } from "./legacy/types"` statement instead of opening a
  second statement from the same module. The barrel's contents are §4.13.1's list exactly (`reader.test.ts` pins
  the value exports), and the DoD's other barrel greps hold.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4)

- `bun run --cwd packages/importer test`: 142 passed, 1 skipped (the live OD-17 case; `LEGACY_ODBC_DSN` unset), in
  17 files — adding `templates` 12, `questions` 12, `snapshot` 16 and `cli` 15; `reader` re-pins the barrel and
  `odbc` is unchanged at 6 + 1 skipped. `questions`, `snapshot` and `cli` each failed first (missing module, then
  seven failing `cli` cases before the commands existed); `templates` first failed on a parse error in the new
  module (a `*/` inside a doc comment), then passed.
- `tests`: `regression/sah-077` 7 (7A, 7C and 9A blocks), and `invariants/lint-rules`, `type-resolution`,
  `logical-properties`, `lint/*` — 85 in 9 files. `bun run --cwd packages/contracts test` 69; `scripts/lint` 12.
- `bun run typecheck` 15/15 (the `tests` workspace now type-checks against `@dulja/importer`), `bun run lint`,
  `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`, and the seventeen `scripts/check/*.sh`
  gates. No route or schema changed, so `openapi.json` is untouched.
- Against the corpora: `bun run legacy templates --fixture base` → `templates: 5 rows, 1 empty, 1 customisations;
  the dossier ships 255`, `wrote: 7 artefacts`; `legacy questions --fixture questions` → five lines each ending
  `verdict: owner (OD-27)`, VII-7 `MatOpens.Job differs from 0 on 1 of 2 rows …`; `legacy all --fixture base` →
  exit 0, `wrote: 24 artefacts`, `next: the owner reads reconciliation and open-questions, and answers OD-16, OD-25
  and OD-27`; `legacy snapshot --fixture base --tables ACCOUNTS,VOUCHERS` → `snapshot: 2 tables, 7 rows, 1 columns
  pseudonymised, 0 omitted`, `wrote: 5 artefacts`, and no corpus name in the output; `legacy scope --fixture base
  --mpos` with `LEGACY_MPOS_DSN` unset → exit 2. The slice DoD's greps: no `` ` + `` in `odbc.ts`; the barrel names
  none of `snapshot`, `mpos`, `drivers/sql`, `cli`, `catalogue/questions`; `packages/db/migrations/` unchanged since
  `dc907e5`; `git status --porcelain artefacts/` empty.
- **Not verified:** the root `bun run test` (its PostgreSQL suites are untouched by 9A and were not re-run); any
  live read — `constraints`' statement, the template blobs' byte transport, the probe and the snapshot against a
  Firebird engine (OD-17); the native `odbc` binding, not built in this environment; a run on Windows, where the
  owner extracts.

## 9A exit (2026-11-13)

**Built:** `@dulja/importer` — the `LegacyDriver` port with its fixture and live ODBC drivers, one SQL renderer over
catalogue-validated identifiers and bound values (ADR 0082), `LegacyReader` verbatim from §4.13.1, `scope` and
`profile`, the hashed artefact format (ADR 0083), the OD-16 `mpos` decision input, the six reconciliation reports of
§5.1 (#1–#5 and #12, with OD-25's input), the report-template catalogue (§5.1 #9, SAH-077), the OD-27 open-question
probe with `LegacyDriver.constraints`, the anonymised staging snapshot (spec:2272), and the `legacy` CLI's seven
commands and exit codes, with `docs/runbooks/legacy-extraction.md`. The barrel is §4.13.1's list exactly; 9B
consumes nothing by a deep path. One error code (`ERR_IMPORT_SOURCE_UNREADABLE`); no migration (0100 stays unused),
route, permission, job or screen. **Verified** against the three committed synthetic corpora only: 142 importer
tests and one skipped live case, the SAH-077 `— 9A` block, typecheck in fifteen workspaces, lint, the eleven custom
rules, format and the seventeen gates. **Owner-gated, and not decided here:** **OD-17** — read access to the live
database and its Firebird version; nothing in 9A has read a live byte, and ADR 0081's three decisions stay blank
until the owner's scoping run; **OD-16** — whether historical POS data migrates (default built: start clean;
`--mpos` produces the evidence); **OD-27** — the five Part VII answers (#6, #7, #8, #9, #13), for which the probe
ships and every verdict is empty; **OD-25** — the suspense treatment, 9B's gate, whose input `unbalanced_vouchers`
supplies; and the owner's approval of ADRs **0081, 0082 and 0083** (all Proposed; 0082 and 0083 carry owner
questions). Every recompute formula, orphan rule, employee match strategy and personal-column rule is a
`hypothesis` until a live catalogue confirms its table and column names. 9A therefore exits on its local
equivalents; its live half waits on OD-17.

## 9B T0–T2 (2026-11-13)

### Built

- **T0** — Plan Contracts **round 20** (`## Round 20 — Phase 9B contracts (2026-11-13)`): C1–C15 applied in place —
  §3.11 (`LEGACY_ODBC_DSN`'s row split; the worker joins its holder, C10), §4.2.6 (`JobPayload["admin.import.run"]`,
  C3), §4.2.7 (the `imports` and `/v1/jobs` module rows, C4 and C2), §4.6.1 (`import_batch.source_hash`, C7),
  §4.13.2 (C8, C9, C12–C15 in the code block, with `SourceColumn` and `SkipRecord` given their bodies and N1–N16
  listed beneath), §4.13.3 (`OB`/`OS`, C1), §4.15 (`3900`, C11), §4.17 (`seedImportBatch`, C5), §4.17.1
  (`tests/invariants/support/cut-over.ts`, C6) and a pointer on round 3's 4.11.2 row (C2 narrows it; the row is
  quoted in round 20). **C16** records the thirteen places the plan was stale against the tree. None of C1–C15 is
  moot. `scripts/check/contracts-9b-amendments.sh` (doc literals plus 9A/0B/1A/7A/7C/8A/8C repo surfaces, and a
  `refuse_contract` check that `LEGACY` is gone from §4.13.3) runs in CI's `checks` job after the 8D gate.
- **T1** — migration `0101_add_legacy_ref.sql` / `0101.down.sql`: `legacy_ref text` (nullable) on `app.document`,
  `party`, `item`, `account`, `employee`, `lot`, each with a partial, non-unique `<table>_legacy_ref_idx` on
  `(company_id, legacy_ref) where legacy_ref is not null`. The six Drizzle mirrors gain `legacyRef` and the index;
  the six tenant-export rows (`EXPORT_TABLES`) gain `legacy_ref`. `packages/db/test/import/legacy-ref.test.ts` (6
  cases); `tests/regression/sah-051.test.ts` gains a `— 9B` block.
- **T2** — migration `0102_create_import_batch.sql` / `0102.down.sql`: `app.import_batch` (forced RLS and
  `tenant_isolation`, composite `(tenant_id, company_id)` FK, `audit_row`, `stamp_loaded_by`, `loaded_by` → 
  `app.principal`, four CHECKs, `import_batch_natural_key unique (company_id, source_table, source_key)`, two
  indexes, **UPDATE revoked from `app_rw`**); the Drizzle mirror `packages/db/src/schema/import-batch.ts`
  (`importBatchTable`; the mirror count moves 90 → 91); `packages/db/src/import/batch.ts` and its barrel, re-exported
  from `@dulja/db`: `recordBatch`, `findBatch`, `byLegacyRef`, `batchCounts`, `sourceHashOf`, `ImportBatchError`,
  `ImportBatchRow`, `RecordBatchInput`, `RecordBatchOutcome`; `seedImportBatch(db, s, opts)` in
  `packages/db/test/fixtures.ts` (reachable as `@dulja/db/test`); `import_batch` pinned whole in `NEVER_EXPORTED`;
  `ERR_IMPORT_DUPLICATE_SOURCE_KEY` (409) in `ERRORS`, pinned in `packages/contracts/test/contracts.test.ts`.
  `packages/db/test/import/batch.test.ts` (13 cases).

### Deviations from the plan text

- **Round number.** The plan asks for C2 as "a round-4 settlement"; rounds 4–19 are taken, so everything is round 20.
- **The tenant export (7C) postdates the plan.** `legacy_ref` is registered on the six export rows (the customer's own
  identifier is part of their books); `import_batch` is pinned whole as plumbing. The plan touched neither.
- **`containerSecrets` is `apps/edge/src/container-env.ts`**, not `infra/src/secrets.ts` (C16 item 1) — for Task 9.
- **`NEVER_READ` is not in the importer barrel** (C16 item 13); 9B's gate checks `src/snapshot.ts`.
- **Mirrors** use the tree's array-form extra-config callback; `employee.ts` gains its first callback.
- **SAH-051 `— 9B`** is written through `sliceRegression` and asserts behaviour (two drafts share one legacy number,
  neither numbered), not only the catalogue.
- **`import_batch`** — beyond the plan: UPDATE revoked from `app_rw` (the mapping never moves, in the data layer);
  `loaded_by` references `app.principal`; the natural key is named; four negative CHECK cases, a cross-tenant write
  refusal and a cross-tenant resolver case added to the plan's tests.
- **`recordBatch`'s invisible-conflict branch** is reachable by design (a conflict arbitrated against a row RLS hides),
  not only by a rollback race; it raises `ImportBatchError` (code `ERR_IMPORT_DUPLICATE_SOURCE_KEY`) instead of a bare
  `Error`. A `conflict` outcome is still returned, not thrown — the caller (Task 3) raises or counts it.
- **`findBatch.createdAt`** is RFC 3339 UTC to the microsecond, not the session time zone at second precision.
- **Tests import from the tree's paths** (`../harness`, `../fixtures`, `../../src/export/tables`).
- **6C's employee column pin** (`packages/db/test/staff/employee.test.ts`, "exactly the frozen columns") listed every
  later slice's column by name; T1's `legacy_ref` is set aside there as `NINE_B`, beside 8A's and 8D's. The pin was
  found by the full-suite run and fixed in the T2 commit.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/db test` (full): **2,401 passed, 5 skipped, 2 failed in 240 files** before the employee pin
  fix; after it, `test/staff/employee.test.ts` 7/7. The other failure — `test/reports/7b-report-indexes.test.ts`, "a
  timezone date companion compiles to bounds on its instant, and the planner seeks them" (`shift.opened_on`: the
  planner keeps `shift_company_opened_idx`'s `company_id` seek and filters `opened_at`) — is **not 9B's**: it fails
  identically with `0101`/`0102` moved out of `migrations/`, and 9A changed nothing in `packages/db`. Recorded, not
  fixed (outside this task group).
- Focused: `test/import/legacy-ref.test.ts` 6, `test/import/batch.test.ts` 13, `schema-mirror`, `privileges` (the
  up → down → up fingerprint case), `export/*`, `schema-lint`, `migrations`, `migrate`, `expand-contract`,
  `document-header-guard`, `party`, `tenant-isolation`, `audit`: all pass.
- `tests`: `regression/sah-051` 7 (the `— 9B` block included), `sah-047`, `sah-083`, `sah-084`,
  `invariants/report-catalogue-pins`, `invariants/export-audit`, `invariants/hr-sensitive-side-channels`: pass.
  `apps/api` `routes/admin/exports*.test.ts` 16 and `apps/worker`'s export handler test 9: pass.
- `bun run --cwd packages/contracts test`: 69. `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11
  rules, 0 violations), `bun run format:check`, all eighteen `scripts/check/*.sh` gates (the new 9B gate included), and
  a regenerated `openapi.json` with no diff (no route changed).
- **Not verified:** the whole `tests`, `apps/api` and `apps/worker` suites (only the cases these tasks touch);
  Windows; any deployed database.

## 9B T3 (2026-11-13)

### Built

- **The loader framework** under `packages/importer/src/load/`: `types.ts` (`LoadContext`, `Loader`, `RefResolver`,
  `SourceColumn`, `SkipRecord`, `LoadResult`, `LoaderReport`, `LoadReport`, `LoadErrorCode`, `LoadError`),
  `scalar.ts` (`requireText`, `optionalText`, `moneyOf`, `quantityOf`, `dateOf`, `optionalDateOf`), `preflight.ts`
  (`preflight`, `PreflightFinding`, `PreflightReport`), `refs.ts` (`refResolver`), `registry.ts` (`loaders` — empty at
  this task — `loaderFor`, `orderLoaders`) and `run.ts` (`runLoad`, `LoadSource`, `LoadSourceFactory`,
  `setLoadSource`, `loadSourceFromEnv`, `loadSource`, `baseCurrency`, `EMPTY_TARGET`, `READ_BATCH` = 500). All of it
  is re-exported from the `@dulja/importer` barrel; `test/reader.test.ts`'s by-value pin grows by nineteen names.
- **`packages/importer/package.json`** takes `@dulja/db`, `@dulja/domain` and `postgres` (types for `Sql`); not
  `@dulja/contracts` (nothing imports it — `LoadError` is the package's own class).
- **The CLI's `load` command** (`--tenant-id`, `--company-id`, `--cut-over-date`, `--dry-run`, `--only a,b`, the
  source from `--dsn`/`--fixture`, the database from `DATABASE_URL`), running `runLoad` as the tenant's system
  principal with a fresh run id. Exit 0 clean, 1 loaded with skips, 2 configuration or a refusal, 3 unreadable source
  or failed pre-flight.
- **Test tier:** `test/support/tenant.ts` (`seedLoadableTenant`, `loadContextFor` — N16, moved here from Task 4 so
  the framework's own suite runs against the tenant every later suite uses); the `cut-over` corpus
  (`catalog.json`, `UNITS.json`); `test/load/preflight.test.ts` (8), `scalar.test.ts` (6), `registry.test.ts` (5),
  `run.test.ts` (19, PostgreSQL 18 Testcontainers), two `load` cases in `test/cli.test.ts`.
- **ADR 0084** (Proposed) and a `— 9B` block in `tests/regression/sah-049.test.ts` (two cases: `recordBatch`'s skip,
  and `runLoad` loading a twice-held key once with the second sighting in the register, and refusing a third
  different one).
- **CI:** `@dulja/importer` leaves the Windows `checks` job's turbo filter and joins the Linux `database` matrix; its
  exclusion reason is on `scripts/lint/rules/ci-test-filters.ts`'s list.

### Deviations from the plan text

- **No placeholder batch row.** The plan's `runLoad` wrote each `import_batch` row with `EMPTY_TARGET` before `load`
  and filled the target in with an `UPDATE` (`linkBatches`); 0102 (T2) revoked UPDATE from `app_rw`, so that cannot
  run. The order is now: `findBatch` (refuse a changed or re-targeted key, skip an identical one, before `map`), `map`,
  `load`, then `recordBatch` with the target id `load` answered — one transaction per page. The guarantee the plan
  wanted (a changed source refused before anything is written; nothing partial committed) holds; `EMPTY_TARGET` keeps
  only its committed meaning. A `recordBatch` that finds the key taken meanwhile (a concurrent load) refuses the page.
- **In-run duplicates (SAH-049).** The plan's order would have recorded the first sighting and then — on a duplicate
  key in the same page — handed both rows to `load`. `runLoad` now remembers each key's hash per loader for the run:
  an identical second sighting is loaded once and reported in the skip register; a different one refuses with
  `ERR_IMPORT_DUPLICATE_SOURCE_KEY`, across pages and in a dry run.
- **The resolver's source table comes from the registry**, not the plan's `SOURCE_OF` list: the loader that targets a
  table is the one place the pairing is written, so it cannot drift. `orderLoaders` refuses two loaders with one
  target table. Tasks 4–8 therefore add no second list; a loader's `sourceTable` and `sourceKey` are the contract.
- **A dry run never calls `load`** and needs no rollback sentinel (nothing is written before `load`).
- **Reads only declared columns the catalogue has.** The fixture driver (and the live one) refuse a column the table
  lacks, so a missing OPTIONAL column, which pre-flight lets through, is not read and maps and hashes as NULL.
- **Page outcomes merge after commit.** `withTenant` retries a deadlock once; counts, skips and the in-run key memory
  are built inside the transaction and merged only after it commits.
- **`moneyOf`/`quantityOf`** round through the domain's `round(…, "HALF_AWAY_FROM_ZERO")` rather than decimal.js
  directly, accept any number of fraction digits and an exponent (a Firebird `float` cast to text), and refuse a value
  numeric(19,4)/(19,6) cannot hold. `dateOf` checks a real calendar date with the domain's `isCalendarDate`.
  `moneyOf` is generic in the currency, so `moneyOf(row, c, baseCurrency(), …)` is `Money<CurrencyCode>`.
- **Parameter names.** The plan's `where` parameter became `site`: `no-sql-concat` reads `${where}` in an untagged
  template as SQL.
- **`runLoad` also refuses**: an `only` naming no registered target or empty; a registered loader with no source
  columns; a run id that is not a uuid; a cut-over date that is not a calendar date; a second concurrent run in one
  process (the source and currency ports are module-scoped). A refused run writes `load-failed.json` and the index.
- **CLI exit for skips is 1, not the plan's 3** — 3 is 9A's `ERR_IMPORT_SOURCE_UNREADABLE`. Flags are 9A's
  `--key value` form; `load` opens its own source through `setLoadSource` (the driver is not opened twice).
- **`seedLoadableTenant`/`loadContextFor`** land at T3 (the plan's T4 Step 3), as the brief scopes them here.
- **SAH-049 `— 9B`** drives `runLoad` through the `@dulja/importer` barrel as well as the plan's `recordBatch` case,
  and runs the `recordBatch` case as the system principal.
- **ADR 0084 is Proposed**, not Accepted, with two owner questions; decisions 8–12 record what the plan's text left
  implicit or the tree changed.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test`: **182 passed, 1 skipped (the pre-existing OD-17 live-ODBC case) in 21
  files**; `test/load/` alone 38. Each new file failed first (module not found) before `src/load/` existed.
- `tests`: `regression/sah-049.test.ts` 6 (the `— 9B` block's two included).
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations — `ci-test-filters` with
  the importer's new exclusion), `scripts/lint/lint.test.ts` 12, `bun run format:check`, and all eighteen
  `scripts/check/*.sh` gates.
- **Not verified:** the `database` CI job's run of the importer workspace (no CI here); the live ODBC source (OD-17);
  Windows.

## 9B T4 (2026-11-13)

### Built

- **Six master-data loaders**, registered in `packages/importer/src/load/registry.ts` in this (topological) order, each
  writing through the tree's own service wherever one exists, as the tenant's system principal, audited:

  | `targetTable` | `sourceTable` | `sourceKey` (the `RefResolver` spelling) | writes through | `legacy_ref` |
  |---|---|---|---|---|
  | `unit_of_measure` | `UNITS` | bare `UNTID` | `createUnit` | — (no column) |
  | `warehouse` | `WAREHOUSES` | bare `WARID` | `createWarehouse` (kind `stock`, BRANCH `HQ`) | — (no column) |
  | `account` | `ACCOUNTS` | bare `ACCCODE` | links only: `update app.account set legacy_ref` (no service exists) | `ACCCODE` |
  | `party` | `ACCOUNTS` | `ACC:<ACCID>` | tagged INSERT (no service in `packages/db`; the API inserts inline) | `ACCCODE` |
  | `item` | `MATERIALS` | bare `MATID` | `createItem` (§4.6.1's four defaults, hazard 33) | `MATCODE` verbatim |
  | `lot` | `MATBATCHES` | bare `BATID` | `createLot` | `BATCODE` verbatim |

  `dependsOn`: `item` → `unit_of_measure`, `lot` → `item`; the rest none. Every `SourceColumn` is `hypothesis`.
- **`load/master.ts`** (`placeByCode`, `Placement`, `CodedRow`; package-internal): the one create-or-adopt loop the five
  code-keyed loaders share — a free code is created, a code a person made is adopted, a code another legacy key already
  became takes `<code>-<legacyKey>`.
- **`load/account-map.ts`** (`AccountMap`, `AccountMapEntry`, `AccountTreatment`, `ACCOUNT_CODE_PATTERN`,
  `readAccountMap`, `assertAccountMap`, `treatmentOf`) and **`load/accounts.ts`** (`accountLoader`, `setAccountMap`,
  `accountMap`, `clearAccountMap`). **`load/units.ts`** exports `codeFromName` (N14).
- **`load/scalar.ts`** gains `flagOf` (a legacy flag; NULL → `null`, an unknown value refused) and `rationalOf`
  (SAH-066: a legacy float factor → exact `Rational`, never a number or `Money`; NULL, zero, negative and
  non-`bigint`-fitting factors refused).
- **`packages/db`**: `createItem` (`NewItem.legacyRef`) and `createLot` (`legacyRef`) take an optional `legacy_ref`
  (additive; API callers unchanged); `seed/my/chart-of-accounts/9b-cut-over.json` seeds **`3900`** Opening-balance
  suspense (equity, under `3`); `seed-chart.test.ts` and `seed-idempotent.test.ts` count it (41 → 42 applied).
- **CLI**: `load --account-map <path>`, required unless `--only` leaves out `account` (exit 2 before any connection);
  the map is cleared after the run.
- **Barrel** (`reader.test.ts` pin +16): the six loaders, the account-map names, `codeFromName`, `flagOf`,
  `rationalOf`. Contracts round 20's N5/N6 line records `flagOf`, `rationalOf` and `clearAccountMap`.
- **Corpus/fixtures**: `cut-over/{WAREHOUSES,MATERIALS,MATBATCHES,ACCOUNTS}.json` and their catalogue entries (the
  plan's rows verbatim); `test/fixtures/account-map.json`.
- **Tests**: `test/load/accounts.test.ts` (13, pure), `test/load/master.test.ts` (13, PostgreSQL 18), `scalar.test.ts`
  +2, `registry.test.ts` (the empty-registry case becomes the six-loader pin), `cli.test.ts` +1. Regression blocks
  `— 9B` in `sah-007` (2 cases), `sah-073` (1) and `sah-066` (1).

### Deviations from the plan text

- **ACCOUNTS column names.** 9A's `base` corpus spells `ACCOUNTS` unprefixed (`SITE`, `ID`, `CODE`, `NAME`,
  `ISEMPLOYEE`, keyed `(SITE, ID)`); the 9B plan spells it with the dossier's per-table prefix (`ACCID`, `ACCCODE`, …).
  9B keeps the plan's prefixed spelling (dossier analysis §3.1: "a per-table `Prefix` is prepended to every physical
  column name (`Accounts.AccName` …)"; T3's `UNTID` already followed it) in the separate `cut-over` corpus, and leaves
  9A's corpus and readers alone. Both stay `hypothesis`; pre-flight against the live catalogue (OD-17, Task 14) names
  every missing required column, and whichever spelling is wrong is corrected there. No `SITE` column is invented: a
  multi-site source whose `ACCID` repeats with different data is refused by T3's in-run SAH-049 check, never merged.
- **`legacy_ref` on `item` and `lot` is the human code** (`MATCODE`, `BATCODE` verbatim), not the plan's surrogate
  `MATID`/`BATID`: 0101's own column comments say "material code" and "batch code", and the party/account pair
  already carries the human `ACCCODE` (plan R28's reasoning). The `import_batch` source key stays the surrogate id, so
  Task 6's `refs.byLegacyRef("item", MATID)` / `("lot", BATID)` are unchanged. An item without `MATCODE` has a NULL
  `legacy_ref` (its mapping is in `import_batch`).
- **Services, not raw INSERTs** (brief): `createUnit`, `createWarehouse`, `createItem`, `createLot`. The plan's
  `on conflict do nothing` is gone with them; `placeByCode` checks first.
- **Two legacy rows never collapse into one Dulja row.** The plan's `on conflict … then select` mapped a second
  legacy warehouse/item/party whose name gave the same code onto the first row (two items' stock merged). It now takes
  `<code>-<legacyKey>`; a code a person created is still adopted, as the plan intended.
- **Lots**: a legacy batch coded `NONE` (the ADR 0034 sentinel every item already owns) is reported, not adopted; a
  batch whose expiry precedes its manufacture is reported rather than failing the page on
  `lot_expiry_after_manufacture_check`.
- **Flags** go through `flagOf`: the plan's `truthy` read any unknown value (`"2"`) as false.
- **Account loader**: also refuses a map entry that names a group or archived account; the party loader's control
  lookup excludes group and archived accounts. `assertAccountMap` also refuses one legacy code listed twice, two
  legacy codes on one Dulja code with different treatments, an `ar_control`/`ap_control` on more than one Dulja code
  (the plan's test title said "exactly one" while its code only checked "at least one"), unreadable or non-JSON files
  as `LoadError`s, and reads `type` as implied by the code's first digit once checked.
- **Test adjustments** forced by registering real loaders: `run.test.ts`'s `registered` and SAH-049's `— 9B` block (a
  T3 block of this slice) now make their test loader the whole registry and restore it, instead of pushing beside a
  real `unit_of_measure` loader (`orderLoaders` refuses two). The plan's SAH-007 DB case runs on a fresh tenant: on the
  already-loaded one T3's framework refuses the changed `ACCOUNTS` row before `map` (`ERR_IMPORT_DUPLICATE_SOURCE_KEY`).
- **SAH-073 `— 9B`** is written now as a pure `map` case through the barrel; Task 5 may add the corpus-level case
  through `loadFromCorpus` as the plan says. Plan path `fixtures/account-map.json` read via `fileURLToPath`.
- **No MATUNITS loader.** The plan has none, and neither the plan nor the dossier names MatUnits' material or unit
  reference columns (9A's `questions` corpus has `SITE`, `ID`, `UNIT`, `EXCHANGE`); inventing one is hazard 3.
  `rationalOf` fixes the conversion rule the loader must use once OD-17 names them (decisions row).

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test`: **211 passed, 1 skipped (the OD-17 live-ODBC case) in 23 files**; the new
  files failed first (module not found) before `src/load/account-map.ts` and the loaders existed.
- `packages/db`: `seed-chart`, `seed-idempotent`, `test/seed/**`, `test/inventory/**`, `payroll/accounts`,
  `hr/predecessors`, `phase-6d-pins`, `posting/code-review-c`, `currency-fk`, `schema-mirror`, `export/**` — all pass.
  `apps/api`: `routes/accounting/{accounts,document-transfer,landed-cost}` 28 pass.
- `tests`: `regression/sah-007`, `sah-066`, `sah-073`, `sah-049` (6), `sah-051`, `golden/payroll`,
  `invariants/tax-permissions-5a` — pass.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`, and
  all eighteen `scripts/check/*.sh` gates.
- **Not verified:** the whole `packages/db`, `apps/api`, `apps/worker` and `tests` suites (only the cases these changes
  reach); the live source (OD-17); Windows.

## 9B T5 (2026-11-13)

### Built

- **`OPENING_BALANCE`** — `packages/db/seed/my/document-types/OPENING_BALANCE.json`: module `accounting`, series `OB`
  (round 20 C1), `direction: internal`, JOURNAL's two `each_line` rules on `line.kind: account`, no inventory, no tax,
  `approval.required: false` with `post: accounting.journal.post`, reversal allowed into `OPENING_BALANCE`, no required
  dimension. Applied by `bun run seed --only document-types` (the pack's count moves 27 → 28).
- **`load/document.ts`** (N7): `ImportedLine`, `ImportedDocument`, `draftAndPost(tx, ctx, doc)`, `OPENING_BRANCH_CODE`
  (`"HQ"`) and the package-internal `openingBranchId(tx, companyId, why)`. The one place the importer writes
  `app.document`/`app.document_line`: it resolves the type (live, of this company), the series through 1A's
  `resolvePolicy` on the cut-over date, the head-office branch; inserts the header (cut-over date, base currency, rate
  `1.00000000`, `legacy_ref`, optional party/warehouse) and the lines; then returns `postDocument(tx, ctx, { documentId })`
  — issue, number, period check, ledger, projections and audit are the posting service's. It refuses an empty line list
  and any `Money` not in the run's `baseCurrency()`. The warehouse loader now resolves its branch through
  `openingBranchId` (one `HQ` literal, same message).
- **`load/opening-balance.ts`** (N8, N10): `openingBalanceLoader` (`ACCTOTALS` → `opening_balance`, `wholeTable`, source
  key the bare `ACTACC`, `dependsOn: ["account"]`), `SUSPENSE_CODE = "3900"`, `OpeningBalanceTarget`. `map` reports an
  unmapped code, an `exclude` code and the three control treatments (their openings are Tasks 6 and 7's), refuses a NULL
  total (SAH-007) and resolves the account through `refs.byLegacyRef("account", ACTACC)`. `load` posts ONE document: one
  line per `balance` account at its net (an account netting flat opens nothing), the residue on `3900`; all-flat answers
  `EMPTY_TARGET` per row; a residue with no live leaf `3900` raises **`ERR_IMPORT_UNBALANCED_SOURCE`**; a source that grew
  after its opening was posted (and not reversed) raises `ERR_IMPORT_DUPLICATE_SOURCE_KEY` instead of posting a second.
- **`ERR_IMPORT_UNBALANCED_SOURCE`** (422) in `packages/contracts/src/errors.ts`, pinned in `contracts.test.ts`.
- **Registry**: `openingBalanceLoader` between `item` and `lot` (see deviations). **Barrel**: `draftAndPost`,
  `OPENING_BRANCH_CODE`, `ImportedDocument`, `ImportedLine`, `openingBalanceLoader`, `SUSPENSE_CODE`,
  `OpeningBalanceTarget` (`reader.test.ts` pin +4 values).
- **CLI**: `load` needs `--account-map` whenever the run includes `account` **or `opening_balance`**.
- **Corpus**: `cut-over/ACCTOTALS.json` and its catalogue entry (the plan's four rows).
- **`apps/api`**: `OPENING_BALANCE` joins `SERVICE_ONLY` (`apps/api/src/documents/service-only-type.ts`): the generic
  create, line-replace, convert and settlement routes refuse it; the generic reversal does not (reversal is the load's
  undo). `test/routes/accounting/opening-balance-generic.test.ts` (3; 2 fail before the change).
- **`tests/invariants/support/cut-over.ts`** (C6, N15): `CutOverFixture`, `cutOverFixture(name)`, `loadFromCorpus`
  (both overloads), `assertExplained(fixture, tolerance?)`. `reconcileFor` is Task 10's.
- **Regression**: `— 9B` blocks appended to `sah-003` (the corpus load leaves `1000` Dr 5000 / `3900` Cr 5000 and
  `assertExplained` holds) and `sah-073` (the whole load's skip register names the orphaned batch 9001).
- **Tests**: `packages/importer/test/load/opening-balance.test.ts` (13, PostgreSQL 18): one posted `OB 1` on
  2026-01-31 in `HQ` by the system principal; only `balance` lines plus `3900`; the batch row and the three control
  skips; an idempotent re-run; a dry run; **acceptance test 9 re-run** — a cut-over date in 0A's closed 2026-02 is
  refused `ERR_PERIOD_NOT_OPEN` and leaves no document and no batch row; an archived `3900`; a balanced opening (no
  `3900`); a debit residue; an all-flat TB; unmapped/excluded reports and a NULL total; a grown source.

### Deviations from the plan text

- **`dependsOn: ["account"]`**, not `["account", "party", "item"]`: `map` resolves accounts only, and `dependsOn` is
  the list of tables a loader resolves into. With it, `orderLoaders` readies `opening_balance` in `item`'s wave, so the
  registry places it between `item` and `lot` (the T3 invariant "the registry is its own topological order");
  `registry.test.ts` pins the seven, and `master.test.ts`'s six-loader pin filters the document loader out.
- **`map` parses the amounts before resolving the account**, so a NULL total is refused at its row (SAH-007) even on a
  tenant whose chart is not linked yet; the plan resolved first, which hides it behind a "never linked" skip.
- **`draftAndPost`** uses 1A's `resolvePolicy` (the plan hand-queried `posting_policy`), `baseCurrency()` (the plan read
  `company.base_currency` again), `exchange_rate '1.00000000'` and `rate_source` omitted; lines are numbered
  consecutively (the plan used the source row index, leaving gaps for flat accounts); it also refuses zero lines and a
  foreign-currency `Money`. The `3900` lookup also requires a leaf (`not is_group`).
- **The grown-source guard** is beyond the plan (decisions row).
- **Service-only `OPENING_BALANCE`** is beyond the plan (decisions row).
- **`assertExplained`** keeps the plan's "the ledger nets to zero, naming every non-zero balance" and adds the half
  that is not vacuous: every `3900` ledger row belongs to an `OPENING_BALANCE`/`OPENING_STOCK` whose `3900` line carries
  a description. The plan's sum alone can never fail — 1A's deferred constraint already refuses an unbalanced commit.
  The helper reads corpus files with top-level `node:fs` imports and `REPO_ROOT` (not `require`), and removes the run's
  artefact directory after each load.
- **Test reads run as the system principal**: `document` and `ledger_entry` are branch-isolated and the seed's human
  holds no role (the plan read as `s.human` and would have read nothing).
- **The plan calls `ACCTOTALS` "unbalanced by 5000"**: its four rows are out by 8300; 5000 is what the one `balance`
  account nets to, and the 3300 the controls carry is posted against `3900` by Tasks 6 and 7, so after the whole load
  `3900` holds the legacy imbalance only. Task 10 should read it that way.
- **The SAH-073 block** is a second `— 9B` block (T4 wrote the `map`-level one); the SAH-003 block uses
  `sliceRegression`, as the file's earlier blocks do.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test`: **24 files, 224 passed, 1 skipped** (the OD-17 live-ODBC case; 225 tests);
  `test/load/opening-balance.test.ts` 13 — it failed first (module not found).
- `packages/db`: `seed-idempotent`, `test/seed/**`, `posting/reverse`, `ar-ap/item-profitability`, `schema-mirror` — 14
  files, 127 passed. `packages/contracts`: 69.
- `apps/api`: `routes/accounting/opening-balance-generic` (3), `fx-revaluation-generic`, `documents` — 35 passed.
- `tests`: `regression/sah-003`, `sah-073`, `sah-049`, `sah-007`, `sah-066`, `sah-051`, `sah-083`, `sah-084` — 34
  passed.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`, all
  eighteen `scripts/check/*.sh` gates, and a regenerated `openapi.json` with no diff.
- **Not verified:** the whole `packages/db`, `apps/api`, `apps/worker` and `tests` suites; the live source (OD-17);
  Windows.

## 9B T6 (2026-11-13)

### Built

- **`OPENING_STOCK`** — `packages/db/seed/my/document-types/OPENING_STOCK.json`, the plan's envelope verbatim: module
  `inventory`, series `OS` (round 20 C1), `direction: inbound`, `requires: ["warehouse"]`, debit
  `item.inventory_account` / credit `3900` on each item line (round 20 C11), `inventory: receipt` at `header.warehouse`,
  `create_layer`, `allowNegative: false`, no tax, `approval.required: false` with `post: inventory.receipt.post` (3C's
  code; no new permission), reversal into `OPENING_STOCK`. The document-types pack moves 28 → 29.
- **`load/recost.ts`** (N8): `LegacyMovement` (+ `sourceKey`), `OpeningPosition`, `RecostResult`,
  `sortLegacyMovements` (the §4.3.5 key: date, sequence, line), `replayLegacyMovements(movements, method,
  baseCurrency)`. It calls 3B's `costingEngine.cost` — the one implementation — once per legacy movement, with the
  pool keyed as `applyMovements` keys it (item × warehouse; never per lot), stock counted per batch, issues valued at
  the base-currency zero, and the survivors laid onto the batches holding stock with `remainingLayerValue` (exact).
  AVCO merges a batch's parts into one position; FIFO keeps one position per surviving layer, oldest first. A batch an
  issue overdraws is a `negatives` entry and its whole pool opens nothing; a receipt with no value is refused (SAH-011);
  a zero/negative quantity, a foreign-currency value and any `CostingError` refuse naming the row.
- **`load/opening-stock.ts`** (N8): `openingStockLoader` (`BILLITEMS` → `opening_stock`, `wholeTable`, source key the
  bare `BTMID`, `dependsOn: ["item", "warehouse", "lot"]`, ten `hypothesis` columns) and
  `OPENING_STOCK_LINES_PER_DOCUMENT = 200`. `load` refuses (before computing) a grown source while an unreversed
  `OPENING_STOCK` is posted (`ERR_IMPORT_DUPLICATE_SOURCE_KEY`), stock another document type already moved, any
  movement dated after the cut-over date, and a legacy movement dated after it; replays at `company.costing_method`;
  reports (C15) negatives, positions whose item/warehouse/batch did not import, service items, another material's batch
  and batch-less positions of batch-tracked items; posts one `OPENING_STOCK` per warehouse per 200 lines through
  `draftAndPost`; and answers each source row with its own position's document, else its warehouse's, else
  `EMPTY_TARGET`. `inserted`/`skipped` count positions.
- **Registry**: `openingStockLoader` last (after `lot`). **Barrel**: `OPENING_STOCK_LINES_PER_DOCUMENT`,
  `openingStockLoader`, `replayLegacyMovements`, `sortLegacyMovements` and the three types (`reader.test.ts` pin +4
  values).
- **Corpus**: `cut-over/BILLITEMS.json` (10 @ 10.00 in, 10 @ 14.00 in, 5 out, batch 9000) and its catalogue entry.
- **`packages/db`**: `OPENING_STOCK` joins `NON_SALE_MOVEMENT_TYPES` (`projections/item-profitability.ts`, as that
  file's header asks of "the PR that ships it"); `seed/document-types.test.ts` and `seed-idempotent.test.ts` (29).
- **`apps/api`**: `OPENING_STOCK` joins `SERVICE_ONLY`; `test/routes/accounting/opening-stock-generic.test.ts` (2; the
  refusal case failed before the change).
- **`tests`**: `assertExplained` (C6) explains an `OPENING_STOCK`'s `3900` rows by its described item lines (it has no
  `3900` account line — the credit is the policy's leg); a `— 9B` block in `regression/sah-011.test.ts` (2). SAH-003's
  `— 9B` case now loads `OPENING_STOCK` too and still passes `assertExplained`.
- **Tests**: `packages/importer/test/load/recost.test.ts` (12, pure — acceptance test 5 re-run: the history re-costed by
  the engine) and `opening-stock.test.ts` (17, PostgreSQL 18 — **acceptance test 18 re-run through the import path**: a
  history that overdraws is reported, never opened; one posted `OS 1` by the system principal in `HQ`; the layer
  15 @ 12.0000 in batch B-2401 made by `applyMovements`; `valuationAsOf` 180.0000 to the cent; ledger `1300` Dr /
  `3900` Cr 180.0000; idempotent re-run; dry run; the five report reasons; 201 positions → 200 + 1 lines; a late
  legacy movement; the grown source, then reversal on the cut-over date and a reload; the back-dated refusal; stock
  already held). Both failed first (module not found).

### Deviations from the plan text

- **One cost pool per item and warehouse, not per lot.** The plan's "Dulja costs per lot (§4.7.3)" contradicts the
  engine's contract (`openLayers`: "Never per-lot") and `applyMovements`. The plan's "keeps lots apart" case still
  passes (two batches with no issue keep their own layers' values); a new case pins the pooled AVCO figure and one the
  FIFO layer order. Decisions row.
- **A negative batch drops its whole pool**, reported with the batch; the plan dropped only that key.
- **The value is exact** (Σ surviving layers' remaining values) and `unitCost` derived; the plan multiplied a rounded
  average back out.
- **Guards beyond the plan**: grown source, stock already held / a later movement (why no `JobClient` is needed — step
  14 cannot be reached), a legacy movement after the cut-over date, service items, another item's batch, batch-less
  positions of batch-tracked items. **`map`**: `flagOf` for `BTMIN` (NULL refused), whole-number ordinals, an issue's
  value never read, quantity a positive magnitude; never `{ skip }`.
- **`dependsOn: ["item", "warehouse", "lot"]`**, not `+ "opening_balance"` (T5's rule: the tables `load` resolves).
- **`SERVICE_ONLY`**, the `assertExplained` OS branch and `NON_SALE_MOVEMENT_TYPES` are beyond the plan's file list.
- **SAH-011's MATCOSTS check** is scoped to `src/load` and the registry: 9A's profiling names the table legitimately.
- **Two assertions are strings, not regex literals**: `scripts/lint/rules/dependency-rule.ts`'s token scanner stalls
  forever on `#6` inside a regex literal that also holds an escaped `\/` (`bun run lint:rules` hung at 100% CPU). A
  defect of that rule, not fixed here (out of scope); recorded for a follow-up.
- **Test import order**: a loader module imports `./run` and `./refs`, which import the registry, so a test that
  imports a loader module FIRST builds `loaders` with that loader unset. `opening-stock.test.ts` imports the registry
  first (commented); the barrel already does. Later loader tests must do the same.
- **What `3900` holds after the whole load** — not only the legacy imbalance: the legacy `inventory_control` net is
  never loaded and `OPENING_STOCK` credits the RECOMPUTED valuation, so `3900` (credit) = legacy imbalance −
  (legacy inventory-control net − recomputed valuation) − the same for the AR/AP controls (Task 7) − excluded accounts.
  On the corpus: 5000 (OB) + 180 (OS) credit so far; the legacy `1401` is 2400.0000, so the recost difference is
  2220.0000 — Task 10's reconciliation explains it (ADR 0086's "recomputed figure").

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test`: **26 files, 253 passed, 1 skipped** (the OD-17 live-ODBC case); `recost` 12,
  `opening-stock` 17.
- `packages/db`: `test/seed/**`, `permission-catalogue`, `print-render`, `ar-ap/item-profitability`, `seed-idempotent`,
  `posting/reverse`, `costing/valuation`, `schema-mirror` — 24 files, 238 passed.
- `apps/api`: `openapi`, `routes/accounting/{print,document-count,opening-balance-generic,opening-stock-generic,
  inventory-reports,documents,document-transfer,fx-revaluation-generic,document-lifecycle}` — 10 files, 101 passed.
- `tests`: `regression/sah-011` (16, the `— 9B` block's two included), `sah-003`, `sah-073`, `sah-049`, `sah-007`,
  `sah-066`, `sah-051` — 44 passed; `sah-048`, `sah-018`, `sah-031`, `sah-013`, `sah-032` pass;
  `invariants/zero-code-document-type` fails only test 15's known PDF-hyphen case.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 1509 files, 0 violations),
  `bun run format:check`, and all eighteen `scripts/check/*.sh` gates. No route or schema changed, so `openapi.json`
  was not regenerated.
- **Not verified:** the whole `packages/db`, `apps/api`, `apps/worker` and `tests` suites; FIFO through the posting
  service (the replay's FIFO case is pure; the posted cases run at the default AVCO); the live source (OD-17); Windows.

## 9B T7 (2026-11-13)

### Built

- **`load/open-items.ts`** (N10): `openItemLoader` (`BILLS` → `open_item`, paged, source key the bare `BILID`,
  `dependsOn: ["party"]`, six required `hypothesis` columns `BILID`, `BILNUMBER`, `BILACC`, `BILDATE`, `BILOPEN`,
  `BILKIND`) and `OpenItemTarget`. `map` reads the kind (`1` receivable, `2` payable, anything else refused naming the
  row), the amount (NULL refused, SAH-007) and the date before the party (`refs.byLegacyRef("party", "ACC:<BILACC>")`;
  an orphan is reported, SAH-073), reports a zero open amount, and takes the map's `ar_control`/`ap_control` code. The
  amount is a magnitude and `side` carries the direction (a negative `BILOPEN` opens on the other side). `load` refuses
  a legacy document dated after the cut-over date, resolves the control and `3900` codes to live leaf accounts once per
  page, reads each party's `app.party_control_account`, **refuses** an item whose control is not that account, and posts
  ONE `OPENING_BALANCE` per row through `draftAndPost` — line 1 the control (`Open <kind> at cut-over — legacy <number>
  dated <date>`), line 2 `3900` — with `party_id` and `legacy_ref` = the printed number verbatim. Each row's batch entry
  is its own document.
- **Registry**: `openItemLoader` after `openingBalanceLoader`, before `lot` (`orderLoaders` readies it in `item`'s wave,
  after the trial-balance opening, so the opening is `OB 1`). **Barrel**: `openItemLoader`, `OpenItemTarget`
  (`reader.test.ts` pin +1 value).
- **CLI**: `load` needs `--account-map` whenever the run includes `open_item` too; the message lists the three targets.
- **Corpus**: `cut-over/BILLS.json` (the plan's two rows, sharing `INV/2025/0417`) and its catalogue entry.
- **ADR 0085** (Proposed; eight decisions, three owner questions).
- **Tests**: `packages/importer/test/load/open-items.test.ts` (15, PostgreSQL 18; failed first, module not found): the
  loader's shape; `OB 2`/`OB 3` posted on 2026-01-31 in `HQ` by the system principal, `legacy_ref` the shared string;
  the batch rows; Dr `1200`/Cr `3900` and Dr `3900`/Cr `2100`; no income or expense account, no tax fact, no tax code;
  the legacy date in the description and `current` on the cut-over date; `agedBalance` 1800/900, `partyBalance` and
  **`ageingTieOut` `0.0000` on `1200` and `2100`**; `document_series` only `OB`/`OS`; `OB` numbers 1, 2, 3; an
  idempotent re-run; the orphan; a legacy credit on each side (and a zero item reported), ageing −250/−40 and the
  tie-out still zero; the vendor-receivable refusal leaving nothing; an unreadable kind, a NULL amount and a late
  document refused; and **allocation on day one** — a `RECEIPT` through 4A's `draftSettlement` allocated 1000 against
  the opening, `openBalance` 800, ageing 800, tie-out zero. `registry.test.ts`, `reader.test.ts`, `cli.test.ts` and
  `master.test.ts` pins grow by the new loader.
- **Regression**: a second `— 9B` block in `tests/regression/sah-051.test.ts` — the whole corpus load gives the two
  `INV/2025/0417` documents two distinct `OB` numbers (it fails with the loader unregistered).

### Deviations from the plan text

- **The sign.** The plan's `map` took `amount.negate()` for a negative `BILOPEN` and kept the kind's side, so a legacy
  credit note posted as a debit; `OpenItemTarget` gains `side` (the plan's comment names it, its interface did not).
- **`BILKIND`**: the plan read anything but `"1"` as payable; any value but `1`/`2` now refuses the run (T4's `flagOf`
  rule).
- **The control account is checked against the party's ageing account** and a mismatch refuses the run — beyond the
  plan, which posted to the map's control whatever the party aged on (decisions row; ADR 0085 decision 5).
- **A legacy document dated after the cut-over date refuses the run** (T6's rule for movements; beyond the plan).
- **`dependsOn: ["party"]`**, not `["party", "account", "opening_balance"]` (T5's rule: the tables `map`/`load` resolve
  into; the controls and `3900` are seeded chart codes, read by code). Registered before `lot`, not after
  `opening_stock`, so the array stays its own topological order; the opening is still `OB 1`.
- **`map` parses the kind, amount and date before the party** (T5's rule), so a NULL amount is refused even for an
  orphan; the zero check comes after the party, so an orphan is reported as an orphan.
- **Test reads run as the system principal** (T5); the plan's `agedBalance` call lacked the required `limit`; the
  revenue check is "no income or expense account on any open-item row" rather than `4000` alone.
- **This slice's earlier tests were scoped to the trial-balance opening** (`and d.legacy_ref is null`) in
  `opening-balance.test.ts` and SAH-003's T5 block — both selected every `OPENING_BALANCE` row, and the open items are
  `OPENING_BALANCE` documents too. T4's precedent: this slice's own blocks, no other slice's edited.
- **ADR 0085 is Proposed**, not Accepted; it adds decisions 3, 5 and 6 and the consequences the tree forces (ageing
  buckets from the cut-over date; a legacy credit cannot be allocated; base currency only).

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test`: **27 files, 268 passed, 1 skipped** (the OD-17 live-ODBC case);
  `open-items` 15.
- `tests`: `regression/sah-051` (8, the new block failing first with the loader unregistered), `sah-003`, `sah-073`,
  `sah-049`, `sah-011`, `sah-007` — 42 passed.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 1511 files, 0 violations),
  `bun run format:check`, and all eighteen `scripts/check/*.sh` gates. No route or schema changed, so `openapi.json`
  was not regenerated; `packages/db`, `apps/api` and `apps/worker` are untouched.
- **Not verified:** the whole `tests` suite; FX (open items load in base currency only); the live source (OD-17);
  Windows.

## 9B T8 (2026-11-13)

### Built

- **`load/employees.ts`** (N10): two loaders over `EMPLOYEES`, registered `employee` (after `party`, first wave) and
  `employee_ytd_opening` (after `open_item`, `item`'s wave), so the registry stays its own topological order:
  - **`employeeLoader`** (`EMPLOYEES` → `employee`, paged, source key the bare `EMPID`, `dependsOn: []`, six core
    `hypothesis` columns plus `SENSITIVE_SOURCES`' six). One party of kind `employee` plus one `employee` per HR row
    through 6C/8A's **`createEmployee`** (home branch `HQ` via `openingBranchId`, `legacy_ref` = `EMPNUMBER`), the
    sealed fields through 8A's **`writeSensitive`** only, and a leaver created active and then terminated by
    **UPDATE** so 8C's `AFTER UPDATE OF terminated_on` trigger fires (spec:2090). A payroll number a person already
    created is adopted (nothing written, reported through C15); one another legacy row already became refuses the
    run; a party code already taken moves to `<number>-<EMPID>`; a leaver whose `EMPLEFT` precedes `EMPHIRED` is a
    `map` skip.
  - **`employeeYtdOpeningLoader`** (`EMPLOYEES` → `employee_ytd_opening`, source key `YTD:<EMPID>`,
    `dependsOn: ["employee"]`, columns `EMPID`, `EMPYTDGROSS`, `EMPYTDNET`). `map` parses the two figures, runs
    **`assertYtdReconciles`** (gross AND net against the employee's own `PAYITEMS` rows for the cut-over date's
    calendar year), then resolves the employee; `load` writes through 8C's **`upsertEmployeeYtdOpening`**
    (`year`, `byComponent`/`byScheme` `{}`, source `legacy:<runId>`) and adopts an opening it did not write.
  - **`SENSITIVE_SOURCES`** (typed `Partial<Record<SensitiveField, SourceColumn>>`), **`setKeyRing`** /
    **`clearKeyRing`** (module state, the account map's shape), `EmployeeTarget`, `EmployeeYtdTarget`.
- **Framework** (`load/types.ts`, `load/run.ts`): `SourceColumn.sensitive?` — such a value enters the PERSISTED
  `import_batch.source_hash` as presence only (a fixed marker), while the in-run SAH-049 check keeps a full digest in
  memory; non-sensitive loaders hash exactly as before. **`cutOverDate()`**, `baseCurrency()`'s twin. `Loader.map`'s
  doc admits a read of the run's own source (`loadSource()`).
- **`load/scalar.ts`**: **`payMoneyOf`** (`moneyOf` that never prints the value), **`sensitiveOf`** (`text` ≤ 120,
  the wire's limit, or a calendar `date`; never prints the value), **`SENSITIVE_TEXT_LIMIT`**. `load/master.ts`
  exports `mappedByLoad` (package-internal).
- **`packages/db`**: `createEmployee` (`staff/employee.ts`) gains optional `legacyRef` and `partyCode`; the API route
  passes neither and is unchanged.
- **CLI**: `load` builds the ring from `HR_FIELD_ENCRYPTION_KEY` and `HR_FIELD_ENCRYPTION_KEY_VERSION` (worker's
  version rule, no `DEV_HR_KEY` fallback) whenever the run includes `employee`; exit 2 naming the variable, never its
  value; the map and the ring are cleared after every run (and the map on this refusal). The usage line names them.
- **Barrel** (`reader.test.ts` pin +10 values): `assertYtdReconciles`, `clearKeyRing`, `cutOverDate`,
  `employeeLoader`, `employeeYtdOpeningLoader`, `payMoneyOf`, `SENSITIVE_SOURCES`, `SENSITIVE_TEXT_LIMIT`,
  `sensitiveOf`, `setKeyRing`, and the two target types.
- **Corpus**: `cut-over/EMPLOYEES.json`, `PAYITEMS.json` (the plan's rows; every figure and identifier invented) and
  their catalogue entries.
- **Tests**: `test/load/employees.test.ts` (19, PostgreSQL 18; failed first with the module absent — `employeeLoader
  is not defined`). Shape and sensitive flags; one employee party per HR row and no `Accounts` row made a person;
  sealed fields opened with the ring, ciphertext not plain; the `import_batch` hash equals the redacted digest and not
  the full one; the openings (`legacy:<run>`, `loaded_by` the system principal, empty breakdowns, the batch row);
  `employee_ytd` empty, `checkEmployeeYtdProjection` `[]`, `ytdFromEmployeeYtd` 36000.0000 (**acceptance test 35
  re-run**); the termination's audited INSERT then UPDATE (**acceptance test 34 re-run — trigger reached**, effects
  8C's); an idempotent re-run; a drifting gross withheld, reported without a figure, and **loaded on the next run once
  the source is corrected**; a drifting net and the drift reported by a dry run on an empty tenant; no `PAYITEMS`, no
  figures, half a figure; a `manual:` opening left alone; no key ring refused before any write; a malformed national
  id, date of birth and YTD figure refused without the value in the error or `load-failed.json`; leave-before-hire;
  adoption (no sealed row written, the opening still loaded); the party-code move; a duplicated payroll number.
  `registry.test.ts`, `reader.test.ts`, `cli.test.ts` (+1: the HR key refusals) and `master.test.ts` (its six-loader
  and party pins scoped to the party loader's customers and vendors) grow; `master`, `opening-balance`,
  `opening-stock`, `open-items` and `tests/invariants/support/cut-over.ts` set the test ring (`TEST_KEY_RING` in
  `test/support/tenant.ts`).
- **ADR 0084** gains an amendment (decisions 13–14, Proposed); contracts round 20's N3/N5/N10 line records the names;
  `docs/runbooks/payroll-parallel-run.md` item 1 now says 9B loads the openings and the dataset still does not read
  them.

### Deviations from the plan text

- **Two loaders, not one.** The plan reconciled inside `employeeLoader.load` and reported the drift through C15; under
  T3's framework a `load` skip is recorded with its row (ADR 0084 decision 7), so the plan's own remedy ("re-run with
  --only employee") could never load the withheld opening. The opening is its own loader whose `map` does the check,
  so a drift is a `map` skip — not recorded, retried. The employee's hash no longer carries pay figures.
- **`cutOverDate()`** is new (N3): `map` has no `ctx`. The reconciliation also runs in a dry run now (the plan's form
  could not).
- **Gross AND net** are compared (§5.1 #11 names both; the plan compared gross).
- **No figure in any message.** The plan's skip reason printed the stored and summed gross and their difference; a
  salary reaches `skips.csv`, the job log and the API that way. The reason names the employee, the year and which
  figure disagrees. `moneyOf`'s refusal prints the value, so pay figures go through `payMoneyOf`, sensitive values
  through `sensitiveOf` (which also refuses what 8A's wire schema would never read back: > 120 characters, a date of
  birth that is not a calendar date).
- **`legacy_ref` = `EMPNUMBER`**, not `EMPID`: 0101's comment says "the source system's employee number" (T4's rule:
  the column comment wins). The employee's party carries no `legacy_ref` (its comment is the account/customer/vendor
  code, and no link to a legacy account is known).
- **Tree names**: `EmployeeYtdOpeningInput.year` / `listEmployeeYtdOpening(tx, { companyId, year })` (not `taxYear` —
  `no-number-money`), source `legacy:<run>` (8C's form; the plan wrote `sahlisoft:`), `createEmployee` rather than raw
  inserts (T4's services rule). `assertYtdReconciles` takes `{ legacyKey, gross, net }` and `year`.
- **`dependsOn: []`** (T5's rule: nothing is resolved — the employee creates its own party), so `employee` sits after
  `party`, not last.
- **Guards beyond the plan**: adoption of a hand-made employee (the plan skipped without saying why), a duplicated
  payroll number refused, the party-code move, leave-before-hire, missing/half figures, missing `PAYITEMS`, a hand
  opening left alone, the key ring refused before the first write.
- **Test reads run as the system principal** (T5): `employee` is branch-isolated, `employee_sensitive` gated.
- **`SourceColumn.sensitive`** is beyond the plan (decisions row): without it `import_batch.source_hash` is a digest
  of national ids and dates of birth outside `sensitive_gate`.

### For Task 10 (AGENTS.md rewrite) and later tasks

- **AGENTS.md's Phase 8 sentence "the annual statement carries no cut-over opening (the `employee_ytd` dataset reads
  the projection; `employee_ytd_opening` is a read-time addend no row carries until 9B)" is now half stale.** 9B T8
  writes `employee_ytd_opening` rows at cut-over; the plan does not ask for the addend to be wired, and it was not:
  the `employee_ytd` dataset, `hr.annual_statement` and its `projection` tie-out arm still read `app.employee_ytd`
  only, and no production path calls `ytdFromEmployeeYtd` (the calculator reads `ytdFromPostedLines`), so an
  imported opening reaches only `listEmployeeYtdOpening`, the tenant export (`hr.payroll.read`) and the audit trail.
  Rewrite it as: "9B loads `employee_ytd_opening` at cut-over, reconciled to each employee's legacy payslips, but the
  `employee_ytd` dataset and `hr.annual_statement` read the projection only and the calculator reads posted lines, so
  a mid-year switch must not issue that year's statement from Dulja alone, and the first Dulja run's PCB does not see
  the opening (spec:2084's 'computes PCB correctly' is unmet)". Only gross and net are loaded; §5.1 #11's statutory
  shares and PCB are not (column set unconfirmed, hazard 1).
- **Task 9's handler** must `setKeyRing(hrKeyRing())` (the worker's ring, `apps/worker/src/hr-keys.ts`) and
  `clearKeyRing()` per run, beside `setAccountMap`/`clearAccountMap`.
- **Task 10's YTD comparison** cannot print figures into an artefact either; an employee with a withheld opening is
  in the skip register under `employee_ytd_opening`, source key `YTD:<EMPID>`.
- **Task 15 / OD-27 #13**: a source with no `EMPLOYEES` table fails pre-flight for the whole load (ADR 0084
  decision 3); until Task 15 consumes #13, the operator runs `--only` without `employee,employee_ytd_opening`.
- **Test import order**: `cli.ts` now imports `./load/run` before `./load/employees` (a loader module imported first
  builds `loaders` with that loader unset — T6's note).

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test`: **28 files, 288 passed, 1 skipped** (the OD-17 live-ODBC case);
  `employees` 19.
- `tests`: `regression/sah-003`, `sah-049`, `sah-051`, `sah-073`, `sah-007`, `sah-011`, `sah-066` — 7 files, 45 passed
  (the cut-over fixture now loads the two employees).
- `packages/db`: `test/staff/**`, `test/hr/employee-ytd-opening`, `test/hr/sensitive`, `schema-mirror` — 11 files, 92
  passed. `apps/api`: `routes/hr/employees`, `routes/hr/sensitive` — 18 passed.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 1513 files, 0 violations),
  `bun run format:check`, and all eighteen `scripts/check/*.sh` gates. No route or schema changed, so `openapi.json`
  was not regenerated.
- **Not verified:** the whole `packages/db`, `apps/api`, `apps/worker` and `tests` suites; a real legacy payroll and
  its column names (OD-17, OD-23); Windows.

## 9B T9 (2026-11-13)

### Built

- **Migration `0103_create_import_run.sql` / `0103.down.sql`** (9B's spare, §3.4.1; contracts round 20 **C17**):
  `app.import_run` — forced RLS and `tenant_isolation`, composite `(tenant_id, company_id)` FK, `audit_row`,
  `requested_by` stamped, no DELETE; `cut_over_date`, `dry_run`, `only_targets` (1–64 or NULL), `account_map` (an
  object or NULL), `status` (`queued`/`running`/`done`/`failed`), `per_loader`, `skip_count`, `artefact_count`,
  `started_at`/`attempts` (the lease), `finished_at`, `error`; 7C's outcome CHECKs; `import_run_company_created_idx`;
  **`import_run_one_live_per_company`**, a partial unique index on `(company_id) where status in ('queued','running')`.
  Drizzle mirror `packages/db/src/schema/import-run.ts` (`importRunTable`; the mirror count 91 → 92); pinned whole in
  `NEVER_EXPORTED`.
- **`packages/db/src/import/run.ts`** (re-exported from `@dulja/db`): `createImportRun`, `getImportRun`,
  `liveImportRun`, `listImportRuns`, `claimImportRun`, `importRunLeaseState`, `importRunFollowUpOptions`,
  `completeImportRun`, `failImportRun`, `IMPORT_RUN_LEASE_SECONDS` (14,400), `IMPORT_RUN_MAX_CLAIMS` (2),
  `IMPORT_RUN_JOB_OPTIONS` and the types `ImportRunRow`, `ImportRunStatus`, `ImportRunLoaderCounts`, `NewImportRun`,
  `CompleteImportRun`, `ImportRunQueryParams` — 7A/7C's `jobs/lease.ts` machinery over the new table.
- **`JobPayload["admin.import.run"]`** (C3) exactly as the plan writes it; `JOBS` untouched.
- **Contracts** `packages/contracts/src/admin/import.ts`: `StartImportBody` (`cutOverDate`, `dryRun`, `only`,
  `accountMap`), `AccountMapSchema`, `AccountMapEntrySchema`, `ImportAcceptedSchema`, `ImportRunStatusSchema`,
  `ImportRunSchema`/`ImportRunDto`, `ImportRunQuery`, `ImportRunList`, `JobStatusSchema`/`JobStatusDto`.
- **`apps/api/src/routes/admin/import.ts`** — `IMPORT_ROUTE_PATH`, `IMPORT_PERMISSIONS`, `importRoutes`,
  `importRouteModule`, `importRunUrl`: `POST …/imports` (gate `admin.company.manage` at `path:companyId`,
  `Idempotency-Key`, 409 `ERR_CONFLICT_UNIQUE` naming a live run, the row and the job in one transaction with
  `IMPORT_RUN_JOB_OPTIONS`, 202 `{ runId, jobId, statusUrl: "/v1/jobs/<jobId>" }`), `GET …/imports` (keyset list,
  `filter[status][eq]`) and `GET …/imports/{runId}` (the row plus `batchCounts`).
- **`apps/api/src/routes/admin/job-status.ts`** — `JOB_STATUS_ROUTE_PATH`, `jobStatusRoutes`,
  `jobStatusRouteModule`: `GET /v1/jobs/{jobId}`, `membershipOnly()`, `JOB_SUBJECTS` (today `admin.import.run`):
  the envelope tenant, then the run under RLS, of the payload's company, requested by the caller, who still holds
  `admin.company.manage` there; `output` is the subject `{ resourceUrl, status, error }`. Both modules are in
  `buildRoutes`; `openapi.json` regenerated (+2 paths, 1,207 lines).
- **`apps/worker/src/handlers/import-run.ts`** — `importRunHandler`, `importFailureDetail`: no-op on an empty payload;
  claim under the lease (a live claim defers one follow-up via `deferPastLease`, whose `LeasedJobName` gains the job);
  refuses a payload that disagrees with the row; validates the row's account map with `assertAccountMap` and refuses a
  run that needs one and has none, before the source is opened; sets the worker's own HR ring (`hrKeyRing()`) when the
  run includes `employee`; `runLoad` (source: `loadSourceFromEnv`, the default factory); records `done` (fenced) or
  `failed` with `CODE: detail`; clears the account map and key ring after every run; one load per process. Registered
  in `apps/worker/src/index.ts` and `test/support/worker.ts`. `apps/worker` depends on `@dulja/importer` now.
- **`@dulja/importer`**: `ACCOUNT_MAP_TARGETS` and `SENSITIVE_TARGETS` move from the CLI into `load/registry.ts` and
  the barrel (`reader.test.ts` pin +2); the CLI reads them from there.
- **C10**: `apps/edge/src/container-env.ts` passes `LEGACY_ODBC_DSN` to the worker when bound, never to the api
  (`LEGACY_MPOS_DSN` to neither); `apps/edge/src/env.ts` declares it; `docs/runbooks/deploy.md` binds it for the
  cut-over only.
- **Runtime image**: `infra/Dockerfile` copies `packages/importer`'s manifest, `src` and `node_modules`;
  `scripts/lint/rules/dependency-rule.ts` admits `@dulja/importer` in `apps/worker`.
- **Probes**: `PROBES["/v1/companies/:companyId/imports"]` (403) and `PROBES["/v1/jobs"]` (404, a real job enqueued for
  the victim's real run), `JOB_PROBES["admin.import.run"]` (the victim's queued run survives the attacker's job).
- **`tests/invariants/projection-rebuild.test.ts`** — acceptance test 2 re-run after the whole `cut-over` corpus load:
  the six registered projections, no mismatch, no unbalanced document, and the load posted.
- **Records**: contracts round 20 **C17** (applied in §3.4.1, §4.2.7's two rows, §4.6.1, the export-classification
  table) and its four literals in `scripts/check/contracts-9b-amendments.sh`; ADR 0084's **Task 9 amendment**
  (decisions 15–20, Proposed, owner questions 3–5); the comments that said no slice mounts `/v1/jobs` reworded
  (`report-runs.test.ts`, `ExportAcceptedSchema`, `ReportRunAccepted`).

### Deviations from the plan text

- **A run table** (`app.import_run`, C17) the plan does not have: the account map needs a home under RLS, a dry run
  writes no `import_batch` row, and the plan's `singletonKey: companyId` takes pg-boss's 24-hour slot that a finished
  job still holds (a dry run would refuse the real run the same day). Dropped the singleton key.
- **The account map** arrives in the POST body and lives on the row; the plan's handler never set one, so three
  loaders could not have run through the job.
- **The run fails, not the job**: the plan rethrew a `LoadError` (pg-boss retries a deterministic refusal; its raw
  output carries a stack). The plan's third worker case asserts the row's `error` and that the job resolves.
- **`/v1/jobs` is narrower than C2's "membership, envelope tenant"**: registered subjects only, requester only, gate
  re-checked; `output` is the subject, never pg-boss's column.
- **`GET …/imports/{runId}`** reads the run row (any holder of the gate), with `batchCounts` as `perTargetTable`;
  `skips` is a count once done, not the plan's constant `0`. The plan's route test (rows seeded under a random run id)
  now starts the run through the POST.
- **The plan's `infra/src/secrets.ts`** is `apps/edge/src/container-env.ts` (C16 item 1).
- **Handler registration**: `registerHandler` in `index.ts` and `startWorker`, not at module load (the tree's pattern;
  `resetHandlers()` would drop a module-level registration).
- **The `/v1/jobs` probe** enqueues through the real JobClient (pg-boss installed by the probe), not a hand-written
  `pgboss.job` row.
- **`runIntegrityCheck(tx, ctx, opts)`** and six projections (`item_profitability` was missing from the plan's list).
- **`job-isolation.test.ts`**: one cast — with every `JobName` keyed in `JobPayload`, `unknown` no longer type-checks.
- **Pre-existing failure fixed**: `infra/test/dockerfile.test.ts` "copies every workspace manifest" had failed since
  9A T1 added `packages/importer`.

### For Task 10 and later tasks

- **The runbook's step 4** should read: `POST /v1/companies/{companyId}/imports` with `{ cutOverDate, dryRun,
  accountMap }` (the map is required whenever the run includes `account`, `opening_balance` or `open_item`), then poll
  `GET /v1/jobs/{jobId}` until `state` is `completed` and read **`output.status`** (`done` or `failed`, with
  `output.error`); `GET /v1/companies/{companyId}/imports/{runId}` is the run's record. A refused run shows
  `state: completed` with `output.status: failed` (ADR 0084 decision 17). Only one run per company may be queued or
  running (409 otherwise).
- **Artefacts of an API run** (`skips.csv`, `load-summary.json`, …) land on the worker's local disk and no route serves
  them (ADR 0084 owner question 5); the rehearsal (step 3) stays the CLI's.
- **`importRunUrl(companyId, runId)`** is exported from `apps/api/src/routes/admin/import.ts` if Task 10 needs it.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd apps/api test` (full): **1,080 passed, 1 failed in 110 files** — the failure was `test/openapi.test.ts`'s
  pinned path list, which now carries the three new paths; re-run, 3/3. `test/routes/admin/import.test.ts` 15 (13 of
  them failed first with the two modules left out of `buildRoutes`).
- `bun run --cwd apps/worker test` (full): **160 passed in 23 files** plus its two Bun cases;
  `test/handlers/import-run.test.ts` 13.
- `packages/db`: `test/import/run.test.ts` 11 (8 failed first with `0103` moved out), and `import/*`, `audit`,
  `expand-contract`, `export/*`, `export-job`, `migrate` (up → down → up), `migrations`, `privileges`, `schema-lint`,
  `schema-mirror`, `tenant-isolation` — 16 files, 132 passed.
- `tests`: `invariants/tenant-isolation` (both new route probes), `invariants/job-isolation` (the new job probe),
  `invariants/projection-rebuild` (the after-the-load case) — 77 passed; `report-catalogue-pins`, `phase-6c-pinned`,
  `phase-6d-pins`, `phase-5-exit`, `phase-5a-pinned`, `hr-sensitive-side-channels`, `export-audit`, `golden/tax-einvoice`,
  `regression/sah-003`, `-039`, `-046`, `-047`, `-049`, `-051` — 103 passed; `tests/lint` and `invariants/lint-rules` 70.
- `packages/importer` 288 passed, 1 skipped (OD-17); `packages/contracts` 69; `apps/edge` `containers` 10 (the C10 case
  failed first); `infra` 25 (five failed first on the importer copy); `scripts/lint/lint.test.ts` 12.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 1,524 files, 0 violations),
  `bun run format:check`, all eighteen `scripts/check/*.sh` gates (the 9B gate with C17's four literals), and
  `openapi.json` regenerated twice with no further diff.
- **Not verified:** the whole `tests` and `packages/db` suites (only the cases these changes reach); a built runtime
  image (the Dockerfile graph test only); a live legacy source through the worker (no `odbc` binding or Firebird ODBC
  driver, OD-17); Windows.

## 9B T10 (2026-11-13)

### Built

- **`packages/importer/src/load/reconcile-cut-over.ts`** (N9): `Comparison`, `CutOverReconciliation`,
  `reconcileCutOver(tx, reader, ctx)` and `explain(difference, reports)`, re-exported from the barrel
  (`reader.test.ts` pin +2 values). The reconciliation reads only — the frozen source through 9A's reader; Dulja
  through the ledger at the cut-over date, `valuationAsOf` and `listEmployeeYtdOpening` — on the caller's transaction
  as the tenant's system principal, with the account map the load ran with. Four sections, each row judged by ADR
  0086's rule for it, and `ok` = nothing unexplained:
  - **`trialBalance`** per Dulja account the map names (legacy codes summed onto it), debit-positive: `balance` must
    agree to the cent; `exclude` is explained while Dulja holds nothing; `ar_control`/`ap_control` are explained when
    Dulja equals the legacy open items of that side (`BILLS`, Task 7's rules), the legacy control's own drift from its
    items named; `inventory_control` (all such codes together) when Dulja equals the RECOMPUTED valuation, the recost
    from the legacy figure named. A legacy account with a stored balance the map does not name, and a Dulja account
    the map does not name holding a balance, are never explained.
  - **`suspense`** (a widening beyond the plan's interface, recorded in round 20's N9 line): the legacy trial
    balance's own imbalance (Σ `ACCTOTALS` debit − credit), explained by `explain`; and `3900` itself, checked to the
    cent against Σ trial-balance differences − the imbalance, its explanation listing the parts. On the corpus:
    −6080.0000 = 2220.0000 (the recost on `1300`) − 8300.0000 (the imbalance, matched by `unbalanced_vouchers`).
  - **`stockValuation`** per Dulja item and warehouse: `BILLITEMS` parsed by the opening-stock loader's own `map` and
    replayed by `replayLegacyMovements` at the company's costing method, against `valuationAsOf`; unresolved positions
    and Dulja-only valuations are their own unexplained rows; a negative pool is listed with zeros and explained by the
    skip register.
  - **`employeeYtd`** keyed `YTD:<EMPID>`: the opening Dulja holds against Σ the employee's own `PAYITEMS` for the
    cut-over calendar year, gross and net, to the cent. **No pay figure** in any row: `source` is a payslip count,
    `dulja` the opening's provenance (or `no opening (withheld — the skip register names it)`), `difference` `0.0000`
    or which figure disagrees.
  - Refusals: a map entry on `3900`; a source without the `BILLS`/`BILLITEMS` the map's controls need
    (`ERR_IMPORT_SOURCE_UNREADABLE`); a duplicated source key with different values (`ERR_IMPORT_DUPLICATE_SOURCE_KEY`,
    the load's SAH-049 rule); a `BILLITEMS` movement after the cut-over date; an unreadable `BILKIND`.
- **`explain`**: subset search over the reports' SIGNED trial-balance effects — `unbalanced_vouchers`' `netImbalance`
  and `aggregate_drift`'s `ACCTOTALS.DEBIT` − `ACCTOTALS.CREDIT` drift (a missing stored row counting as a stored
  zero) — returning the matched reports' sentences or `null`; the four row-counting kinds are never candidates.
- **`load/run.ts`**: package-internal `withRunScope({ baseCurrency, cutOverDate }, fn)`, so the reconciliation parses
  a source row with a loader's own `map` outside `runLoad` (same one-per-process guard; `loadSource()` stays unset).
- **CLI `reconcile-cut-over`** (`--tenant-id`, `--company-id`, `--cut-over-date`, `--account-map` required, the source
  from `--fixture`/`--dsn`/`LEGACY_ODBC_DSN`, the database from `DATABASE_URL`): writes `cut-over-reconciliation.json`
  and `.csv` (a `section` and an `explained` column) under a run directory of its own with their sha256 in its
  `index.json`, prints a summary line and one `unexplained:` line per row, and exits **0** when nothing is unexplained
  and **4** otherwise (`EXIT_UNEXPLAINED`; 0/1/2/3 were taken — Task 3 moved skips to 1).
- **Corpus**: `cut-over/VOUITEMS.json` and its catalogue entry, in 9A's spelling (`SITE`, `ID`, `ROW`, `ACCOUNT`,
  `DEBIT`, `CREDIT`) — three one-sided vouchers whose per-account sums equal `ACCTOTALS` and whose net imbalance is the
  8300.0000 the legacy trial balance is out by. No loader reads it; 9A's report does.
- **`tests/invariants/support/cut-over.ts`**: `reconcileFor(tx, fixture)` (C6's fifth export, N15) and the importer
  names it needs. **`tests/invariants/cut-over-reconciliation.test.ts`** (5): the trial balance balances with `3900` a
  credit of 6080.0000 (through the tree's per-period `trialBalance`, a witness the reconciliation does not use),
  valuation 180.0000, two reconciled openings, nothing unexplained with `3900` decomposed and `assertExplained`, and no
  live legacy credential in `packages/importer/src`, `apps/worker/src` or `apps/api/src`.
- **Tests**: `packages/importer/test/load/reconcile-cut-over.test.ts` (21; failed first with the module absent): seven
  pure `explain` cases (zero, one report, both in kind order, no match, signed matching, credit drift and missing
  stored rows, non-money and `source_absent` reports never named); eleven PostgreSQL 18 cases after the whole corpus
  load (the clean result section by section; no `VOUITEMS`; a legacy AR control drift explained and an open item Dulja
  lacks refused; an unmapped legacy account; a grown stock history, an unimported material and a negative pool; a YTD
  that does not reconcile, with no figure anywhere in the result; a second tenant loaded without the trial-balance
  opening and with a withheld YTD — `1000` and `YTD:5001` unexplained, `3900` −1080.0000 and still decomposed; the
  `3900` map refusal and a source without `BILLS`); two CLI cases (exit 0 with the artefact, its sha256 and no pay
  figure in the CSV; exit 4 against an empty tenant naming seven rows). `test/cli.test.ts` +1 (the three configuration
  refusals exit 2, never 4) and the help case lists the command.
- **ADR 0086** (Proposed; seven decisions, four owner questions). **`docs/runbooks/cut-over.md`**. Contracts round
  20's N9 line records `CutOverReconciliation.suspense` and the command's name. `docs/runbooks/legacy-extraction.md`'s
  "both are CLI-only" line corrected for C10 (`LEGACY_ODBC_DSN` reaches the worker during a cut-over).
- **AGENTS.md's "Current phase" rewrite (Task 10 Step 7) is deferred to the phase close**, by the lead's direction:
  owner-gate Tasks 11–15 still follow, and the lead rewrites AGENTS.md once the whole phase is verified.

### Deviations from the plan text

- **"Explained" is decided per row by the cause its rule names** (ADR 0086), not by the plan's one subset search
  applied to every `balance` row: the opening posts a balance account's stored net exactly, so the plan's search could
  only ever have matched a coincidence there.
- **`explain` matches signed effects, over the two report kinds that carry money**, in the reports' real shapes
  (`summary.netImbalance`; `aggregate_drift` rows with `rule`, `status`, `difference`, `recomputed`) — the plan summed
  a `difference` field the tree's `unbalanced_vouchers` rows do not have and matched absolute values, so +100 and −100
  reports "explained" 200. `reconcileCutOver` runs those two kinds only: `employee_mapping` refuses the `cut-over`
  corpus (`EMPLOYEES.SITE` — 9A's spelling — is not in it), and the other three count rows.
- **`3900` is decomposed** (`suspense`, a widening) — the plan reported `suspenseBalance` and asserted in prose that it
  was "the total of every explained difference".
- **The trial balance is per Dulja account**, not per legacy row (two legacy codes on one account would each have
  shown the other's balance as a difference), and is read from the ledger at the cut-over date: the tree's
  `trialBalance` takes a `fiscalPeriodId`, not the plan's `asOf`.
- **The stock valuation's source is a real recomputation** (the plan set `source: v.value, dulja: v.value`, which
  cannot fail), through the loader's own `map` and `withRunScope`.
- **The controls are explained only when Dulja equals the legacy open items** — the plan's fixed sentence explained a
  control whatever the sub-ledger load did.
- **No salary in the YTD rows**, and the comparison is Dulja's opening against the payslips (the plan copied the
  opening onto both sides with a constant `0.0000` difference and printed `o.gross`); `listEmployeeYtdOpening` takes
  `year`, not `taxYear` (T8).
- **The CLI** takes `--account-map` (the plan's command never set one, so `accountMap()` would have thrown), reads the
  source as `load` does (never a DSN flag in the runbook), writes the sign-off artefact the ADR names (the plan only
  printed the JSON), and imports `./load/run` before the reconciliation module.
- **The corpus gains `VOUITEMS`**: without it the legacy imbalance has nothing to be matched against and the plan's
  invariant could pass only because its reconciliation never looked at `3900`.
- **The invariant test**: `trialBalance` through the cut-over period's id, the projection's `baseDebit`/`baseCredit`;
  `listEmployeeYtdOpening(…, { year })`; `sourceFiles` imported statically; `3900`'s credit and the decomposition
  asserted, not merely its presence.
- **The runbook** carries the earlier workers' corrections: the legacy ageing printed at the freeze; `--only account`
  as a real run before the dry run; the API path with `accountMap` and `output.status`; the rehearsal on the CLI
  (an API run's artefacts stay on the worker's disk); the DSN in `LEGACY_ODBC_DSN`, never on a command line;
  `bun pm trust odbc`; each seed sub-pack (`roles`, `dimensions`, `fiscal-periods`, `chart-of-accounts`,
  `document-types`, `reports`) and `seed:payroll-accounts`; `HR_FIELD_ENCRYPTION_KEY`; the link to 9A's runbook; and
  `wrangler secret delete LEGACY_ODBC_DSN` at hand-over. The plan's `legacy scope --dsn "$LEGACY_ODBC_DSN"` is gone.
- **ADR 0086 is Proposed**, not Accepted, with four owner questions.

### For later tasks

- **Task 11 (OD-25)** decides the treatment of `3900`; the reconciliation's `suspense` rows are its input. Whatever is
  decided, the decomposition stays the check: a treatment that moves `3900`'s balance into another account must move
  the rule in `reconcileCutOver` with it.
- **Task 14 (OD-17)**: 9A's reports read `ACCTOTALS`/`VOUITEMS` unprefixed and 9B's loaders read them prefixed; the
  live catalogue settles which spelling is wrong, and the committed `cut-over` corpus (which now holds both) follows.
- **Task 15 / OD-27 #13**: a source with no `EMPLOYEES` gives an empty `employeeYtd`, not a refusal.
- **AGENTS.md**: the Phase 8 sentence about `employee_ytd_opening` (T8's note) and Task 10 Step 7's rewrite are the
  phase close's.

### Verification (2026-11-13, Linux, Node 22, Bun 1.4.4, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test`: **29 files, 310 passed, 1 skipped** (the OD-17 live-ODBC case);
  `reconcile-cut-over` 21, `cli` 20.
- `tests`: `invariants/cut-over-reconciliation` (5), `invariants/projection-rebuild`, `invariants/lint-rules`,
  `regression/sah-003`, `sah-007`, `sah-011`, `sah-049`, `sah-051`, `sah-066`, `sah-073` — 10 files, 88 passed (the
  corpus's new table changes none of them).
- `apps/worker`: `test/handlers/import-run.test.ts` 13 (`run.ts` gained a function).
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 1,526 files, 0 violations),
  `scripts/lint/lint.test.ts` 12, `bun run format:check`, and all eighteen `scripts/check/*.sh` gates. No route or
  schema changed, so `openapi.json` was not regenerated; `packages/db` and `apps/api` are untouched.
- **Not verified:** the whole `tests`, `packages/db`, `apps/api` and `apps/worker` suites; a live source (OD-17); a
  real cut-over and the customer's sign-off; Windows.

## 9B T11 — ⚠️ OD-25, the suspense treatment and the cut-over date (2026-11-13)

**Gate: open.** Nothing was decided; the default the plan writes "until provided" is built and pinned.

### Built

- **`docs/owner/od-25-suspense-and-cut-over-date.md`** — the gate record: what the owner provides (the cut-over date;
  one of the three treatments of `3900`), how it is verified (`reconcile-cut-over` exits 0 and its `3900 = …` figure is
  the one the customer initialled), what stands meanwhile (the last day of an open period in rehearsal, the residue on
  `3900`, no JOURNAL), and what does not depend on the answer (`3900`'s code, type and seeding slice; ADR 0086).
- **`docs/runbooks/cut-over-suspense.md`** — the accountant's page: what `3900` holds after a clean load (ADR 0086's
  decomposition, part by part, with the corpus figure), the three treatments with what each costs, and how each is
  executed (a JOURNAL by the accountant after sign-off, dated the day after the cut-over date; the importer never
  writes one); what changes if the owner wants a different account.
- **`docs/runbooks/cut-over.md`** — step 5 gains the treatment branch; step 0's OD-25 item links the record.
- **`packages/importer/test/load/opening-balance.test.ts`** — one pinning case, "OD-25 default: the residue STANDS on
  3900 and the import writes no clearing JOURNAL": after the whole `cut-over` corpus load the company holds only
  `OPENING_BALANCE` and `OPENING_STOCK` documents, and `3900` is `Money` −6080.0000 (not zero). The file gains
  `currency`/`Money` and its own `MYR`, as the plan says.

### Deviations from the plan text

- **The runbook's "What is on it"** is rewritten for the tree: the plan said `3900` carries "the other side of every
  open item and of the opening stock, which nets to zero"; after Task 10 it is decomposed exactly (ADR 0086 decision
  4) into the legacy imbalance, the recost, the AR/AP controls' drift from their items and the excluded accounts, and
  the page says so with the corpus figure. The plan's `suspenseBalance` is the CLI summary's `3900 = …` (T10 prints it
  that way; the JSON's `suspenseBalance` field carries the same figure).
- **The pinning case asserts every document type the load wrote**, not only "no JOURNAL": `seedLoadableTenant` seeds
  no `JOURNAL` type, so the plan's count could never be non-zero; a set of exactly the two cut-over types fails on any
  clearing document, whatever its type. It also pins the figure (the decomposition's), not only non-zero.
- **The owner record** (`docs/owner/od-25-…`) is beyond the plan's file list, on Phase 8's `docs/owner/od-23-…`
  precedent, so the gate has one place that says it is open.
- **The re-run claim** ("clearing `3900` after cut-over leaves `reconcile-cut-over` at exit 0") is stated with its
  reason — the reconciliation reads the ledger at `effective_date <= cut-over date`
  (`reconcile-cut-over.ts`) — and the page adds that a treatment dated on or before the cut-over date must move ADR
  0086's decomposition with it (T10's note).

### Verification (2026-11-13, Linux, Node 22, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test test/load/opening-balance.test.ts`: **14 passed** (13 + the OD-25 pin).
- `bun run typecheck`, `bun run lint`, `bun run lint:rules`, `bun run format:check`: pass.
- **Not verified:** a real cut-over date, a real `3900` figure or a posted treatment (OD-25, OD-17).

## 9B T12 — ⚠️ OD-26, `Users.Password` and the proof that no credential is imported (2026-11-13)

**Gate: open.** The default (a forced reset, never an import) needs no code: it is the absence of one, and this task
makes the absence a test.

### Built

- **`tests/regression/sah-028.test.ts`**, a `— 9B, the import path` block (four cases, through the `@dulja/importer`
  barrel): no registered loader's source table is `USERS`; no declared source column matches `PASSWORD`, `PASSWD` or
  `PIN`; no file under `packages/importer/src` names `USERPASSWORD`, `USRPASSWORD`, `USRPIN` or `USERPIN`, and no file
  under `packages/importer/src/load` names a password or a PIN at all; the invite body (`InviteUserBody`) has exactly
  `email` and `displayName`, and a `password` sent beside them is answered 201 with nothing of it echoed.
- **`packages/importer/test/load/registry.test.ts`** — "keeps 9A's NEVER_READ deny-list intact, and no loader declares
  a column it lists" (`USERS.PASSWORD`, `USERS.PIN`; no declared `TABLE.COLUMN` is on it; no `USERS` source).
- **`docs/runbooks/cut-over.md`** step 6 gains the OD-26 verification and the "if yes, hashed with X" paragraph;
  **`docs/owner/od-26-legacy-passwords.md`** is the gate record.

### Deviations from the plan text

- **`NEVER_READ` is asked inside the package**, not from `tests/`: the barrel does not re-export it (C16 item 13; the
  T0 decisions row says Task 12 imports it inside the package). The plan's third SAH-028 case moved to the importer's
  registry test and gained the cross-check the plan's pair of cases implied (no declared column is on the list).
- **The invite case asserts the tree's behaviour**: the plan expected `ERR_VALIDATION_FAILED` for a body carrying
  `password`; `InviteUserBody` is a non-strict Zod object, so the extra member is dropped and the invite answers 201 —
  which the existing 0B block of this file already pins ("the password went nowhere"). The 9B case asserts the
  structural half (the schema has two members) and that the answer echoes nothing; making the schema strict would
  change a ratified route's behaviour and is not this task's.
- **The source scan is widened** to `\bUSERPIN\b` and to a whole-word `PASSWORD|PASSWD|PIN` over `src/load` (the lead's
  "PASSWORD/PIN never named in src/load"); each scan first asserts it read files, so an empty glob cannot pass.
- **The block uses `fullRegression`** (the file's own helper, with `expect` from the context — `no-shadow`), not a bare
  `describe`; `sourceFiles` is the file's existing `syncCredentialSources` import.
- **The owner record** is beyond the plan's file list (T11's precedent).

### Verification (2026-11-13, Linux, Node 22, PostgreSQL 18 Testcontainers)

- `tests`: `regression/sah-028.test.ts` **11 passed** (7 + the four 9B cases).
- `packages/importer`: `test/load/registry.test.ts` **6 passed** (5 + 1).
- `bun run typecheck`, `bun run lint`, `bun run lint:rules`, `bun run format:check`: pass.
- **Not verified:** the owner's answer to Part VII #4 (OD-26).

## 9B T13 — ⚠️ OD-16, the historical POS loader, written and NOT registered (2026-11-14)

**Gate: open; default "start clean".** No run touches `mpos`.

### Built

- **`packages/importer/src/load/mpos.ts`**: `mposLoader` (`POSTICKETS` → `pos_ticket`, source key the bare `PTKID`,
  `dependsOn: ["item", "warehouse", "party", "employee"]`, seven `hypothesis` columns `PTKID`…`PTKTENDER`),
  `MPOS_SOURCE_TABLES` (`["POSTICKETS", "POSENTRIES"]`) and `HistoricalTicket`. `map` reports a ticket with no terminal
  and a tender outside 6A's four (`cash`, `card`, `transfer`, `store_credit` — `TenderMethodSchema`), keeps the
  ticket's own sale date, and mints the tender in `baseCurrency()`; `load` **refuses** with
  `ERR_VALIDATION_FAILED`, naming what a yes would take. The docstring names the tree's real 6A/6D surfaces a yes would
  consume — `applyBatch(tx, ctx, terminal, batch)` (`packages/db/src/sync/apply.ts`), `TicketBatch.shifts`
  (`packages/sync/src/messages.ts`), `applyShiftOpen`/`applyShiftClose`/`assertShiftKnown`
  (`packages/db/src/sync/shifts.ts`) over `app.shift` (0070), `zReport` (`packages/db/src/reports/pos.ts`) — and imports
  none of them.
- **Barrel**: `mposLoader`, `MPOS_SOURCE_TABLES`, `HistoricalTicket` — **exported, not registered** (`reader.test.ts`
  pin +2 values).
- **Corpus** `packages/importer/test/corpus/mpos-history/` (`catalog.json`, `POSTICKETS.json`, `POSENTRIES.json` — the
  plan's rows; every figure invented).
- **Tests**: `test/load/mpos.test.ts` (5; failed first, module not found): not registered (no `pos_ticket` target, no
  `mpos` source table, no `PTK*` column in `loaders`); pre-flight clean against the corpus; the corpus's first ticket
  mapped (terminal, cashier, own date, `cash` 45.0000) and its second reported (`voucher`); a terminal-less ticket
  reported; `load` refuses. Pins: `registry.test.ts` (`loaders` does not contain `mposLoader`; `loaderFor("pos_ticket")`
  still throws naming the eleven), `run.test.ts` (+1, PostgreSQL 18: `only: ["pos_ticket"]` — the CLI's `--only` and the
  job's `only` — refused before any source opens, naming the eleven registered targets). `master.test.ts`'s pin filters
  the registry and is unchanged and green.

### Deviations from the plan text

- **A corpus of its own, `mpos-history`**, not the plan's `test/corpus/mpos/`: that directory is 9A Task 6's
  (unprefixed `SITE`/`ID`/`DATE`/`TOTAL`), and `test/mpos-scope.test.ts` pins its row counts and date ranges
  (`POSENTRIES` 1 row; the plan's has 3). T4's precedent: 9B's prefixed spelling in a separate corpus, 9A's left alone.
- **The test maps under `withRunScope`** (package-internal, T10): `map` calls `baseCurrency()`, which throws outside a
  run, so the plan's bare `mposLoader.map(row, refs)` could not run. It maps the corpus's own rows rather than inline
  literals, adds the refusal case, and passes the loader to `preflight` through the registry's `Loader<unknown,
  unknown>` cast.
- **`load` takes `(_tx, _ctx, rows)`** and does not import `Sql`/`LoadContext` (unused under `noUnusedLocals`); a blank
  terminal (`"  "`) is reported like an absent one; the tender list is a local constant because the importer may not
  import `@dulja/contracts` (§3.1).
- **`buildTicket` and `seedShift`** (plan "Consumes") are not production names in the tree: there is no `buildTicket`,
  and `seedShift` is a `packages/db/test/fixtures.ts` helper. The docstring names the production surfaces instead.
- **The `run.test.ts` refusal** is beyond the plan: it is the one place the CLI and the job meet the registry.

### Verification (2026-11-14, Linux, Node 22, PostgreSQL 18 Testcontainers)

- `packages/importer`: `test/load/mpos.test.ts` 5, `mpos-scope` 4, `run` + `registry` + `reader` + `master` — 49 passed
  across the five loader/registry files.
- `bun run typecheck`, `bun run lint`, `bun run lint:rules` (11 rules, 1,528 files, 0 violations),
  `bun run format:check`, all `scripts/check/*.sh` gates.
- **Not verified:** any `mpos` database; the `POSENTRIES` mapping; 6D's shift for a historical ticket (OD-16).

## 9B T14 — ⚠️ OD-17, the live database and the columns that become `verified` (2026-11-14)

**Gate: open.** No live catalogue was read and **no column is promoted**: every declared source column stays
`hypothesis`.

### Built

- **`packages/importer/test/load/preflight.test.ts`** — hazard 3's ratchet over every declared loader (the eleven
  registered plus T13's unregistered `mposLoader`): every column is `verified` or `hypothesis` and none is `verified`
  without its `TABLE.COLUMN` in ADR 0084; **with OD-17 unanswered, none is verified** (the gate's own pin, deleted in the
  commit that records the reading); every column carries a non-empty note. And the **env-gated live case**, skipped
  unless `LEGACY_ODBC_DSN` is set (9A's `odbc.test.ts` shape, contracts §3.7.1): pre-flight of the registered loaders
  against the live catalogue must report zero required-column findings, and it prints one `finding:` line per missing
  declared column and one `confirmed:` line per present one — the list step 4 of the procedure promotes. It needs no
  Dulja database and writes nothing.
- **`docs/owner/od-17-live-database.md`** — the gate record and the promotion procedure: scope; pre-flight against the
  live catalogue (the live case, then a dry run); reconcile; promote exactly the `confirmed:` columns (a missing one is
  removed, never renamed); record the reading in ADR 0084 with only `redactDsn`'s output and delete the pinning case in
  the same commit; re-run. It also names the spelling question the reading settles (9A unprefixed, 9B prefixed — both
  hypotheses, both in the `cut-over` corpus).
- **`docs/runbooks/cut-over.md`** step 3 points at the procedure.

### Deviations from the plan text

- **No ADR 0084 Consequences entry and no promotion** — the plan's Steps 3–5 need the owner's database; ADR 0084 is
  unchanged (it already says a promotion adds a Consequences line). The template moved to the owner record.
- **The live case is beyond the plan's file list**: the plan's Step 3 runs three commands by hand; the case makes the
  column-by-column comparison mechanical, so step 4 promotes a printed list rather than a transcription.
- **The "none is verified" pin** is beyond the plan: without it, a promotion with a matching ADR line but no live
  reading would pass the ratchet. The ratchet also covers the unregistered `mposLoader`, which a yes to OD-16
  registers as is.
- **ADR path** read with `fileURLToPath(new URL(…, import.meta.url))`, not a cwd-relative path.

### Verification (2026-11-14, Linux, Node 22)

- `packages/importer`: `test/load/preflight.test.ts` **11 passed, 1 skipped** (the new OD-17 live case).
- `bun run typecheck`, `bun run lint`, `bun run lint:rules`, `bun run format:check`: pass.
- **Not verified:** the live case itself, the three verification commands, any promotion (OD-17).

## 9B T15 — ⚠️ OD-27, consuming Part VII #7 and #13 (2026-11-14)

**Gate: open** (`part7-7` and `part7-13` unanswered). #7 is now asked of the customer's data and fails closed; #13 runs
Task 8 and reports what it finds, as the plan's default says.

### Built

- **`packages/importer/src/load/matopens-guard.ts`** (N11): `JOB_PARTITIONED_TABLES` (`[{ table: "MATOPENS", column:
  "MOPJOB" }]`), `JobPartitionFinding`, `assertNoJobPartition(reader)` — `null` when every job is 0/NULL/blank or the
  table is absent, else the distinct non-zero count and up to five values sorted; a present `MATOPENS` whose job column
  cannot be read raises `ERR_IMPORT_SOURCE_UNREADABLE` (unanswerable is not zero). Zero is recognised as text
  (`0`, `-0`, `0.0000`), never through `Number`.
- **`load/opening-stock.ts`**: one call at the top of `load`, on `loadSource().reader`, before the unsafe-opening
  refusals and the replay; a finding refuses `ERR_IMPORT_SOURCE_UNREADABLE` with the plan's message.
- **Barrel**: the three names (`reader.test.ts` pin +2 values).
- **#13 — `load/run.ts`**: a pre-flight that fails on an ABSENT source table now appends the remedy — "If the legacy
  module behind EMPLOYEES is not in use (OD-27; Part VII #13 asks it of EMPLOYEES), re-run with only leaving out
  employee, employee_ytd_opening" (generic over any absent table and the loaders that read it). Behaviour unchanged:
  the run still refuses.
- **Corpus** `test/corpus/matopens-partitioned/` — `cut-over` plus `MATOPENS` (`MOPJOB` 0, 7, 9); a test pins it equal to
  `cut-over` but for that table, so the two cannot drift.
- **Tests**: `test/load/matopens-guard.test.ts` (7; failed first, module not found): the table list, inert values,
  the finding, the five-value cap, an absent table, the fail-closed unreadable column (9A's `JOB` spelling), and the
  corpus pin. `opening-stock.test.ts` +1 (PostgreSQL 18): the partitioned source refused, no `OPENING_STOCK`, no
  `BILLITEMS` key recorded. `employees.test.ts` +2: an empty `EMPLOYEES` loads zero employees and openings and the rest
  loads; an absent one fails pre-flight with the remedy, and the same source with `only` minus the two HR loaders loads.
  `tests/regression/sah-022.test.ts` `— 9B` block (the partitioned corpus refused; `cut-over` loads with no such skip).
- **Records**: `docs/decisions/od-27-9b-part-vii-7-and-13.md` (on 7B/7C's `od-27-…` precedent);
  `docs/runbooks/cut-over.md` step 3 gains the #13 and #7 items.

### Deviations from the plan text

- **Fail closed on an unreadable job column.** The plan's guard "never throws"; with 9A spelling `MATOPENS.JOB` and 9B
  `MOPJOB` (both hypotheses until OD-17), a source in the other spelling would have thrown a bare driver error from
  inside `load`. It now raises a `LoadError` naming the question. The plan's `Number(text) === 0` became a text test
  (Global Constraint 2's spirit; `no-number-money`).
- **#13 does not skip the HR loaders on an absent table.** The plan answers #13 by `--only` when it is "no" and by
  running Task 8 otherwise; it says nothing about an absent table. ADR 0084 decision 3 stays: an absent table fails the
  whole pre-flight, because the loader cannot tell a module never used from a misspelt table (hazard 3), and module use
  is Part VII #13's row-count question. The refusal names the `--only` remedy instead (decisions row).
- **A dry run does not ask #7** (`load` is never called in one); the runbook's #7 item says to read 9A's `part7-7`
  first. Recorded as a limit, not changed: moving the guard into pre-flight would widen the generic pre-flight with a
  loader-specific read.
- **The partitioned corpus is a committed copy** (the plan's instruction) guarded by an equality test; the SAH-022
  block uses `sliceRegression` with a renamed `expect` (`no-shadow`), and string matchers.
- **Error messages are assembled with `join`** where `no-sql-concat` read a template string as SQL.

### Verification (2026-11-14, Linux, Node 22, PostgreSQL 18 Testcontainers)

- `bun run --cwd packages/importer test` (full): **31 files, 331 passed, 2 skipped** (9A's and T14's OD-17 live cases).
- `tests`: `regression/sah-022` 2, `regression/sah-028` 11.
- `bun run typecheck`, `bun run lint`, `bun run lint:rules` (11 rules, 1,530 files, 0 violations),
  `bun run format:check`, all `scripts/check/*.sh` gates.
- **Not verified:** the customer's `MATOPENS` and Salaries row counts (OD-27, OD-17).

## 9B follow-up — ADR 0086's `aggregate_drift` wording (2026-11-14)

ADR 0086 decision 3 described `aggregate_drift` as "how far `ACCTOTALS`' stored totals stand from their recomputation
from `VOUITEMS`" — a magnitude — while `explain` matches its SIGNED effect and prints "`ACCTOTALS`' stored totals less
their `VOUITEMS` recomputation net …". The ADR (and `netEffect`'s docstring in `reconcile-cut-over.ts`) now say what the
code computes: Σ of `ACCTOTALS.DEBIT`'s signed `stored − recomputed` less the same for `ACCTOTALS.CREDIT`, a missing
stored row counting as a stored zero. Wording only; no behaviour, test or interface changed. `bun run format:check`,
`bun run lint`, `bun run typecheck` pass.

## 9B follow-up — the cut-over opening in `hr.annual_statement` (the Phase 8 raise; 2026-11-14)

Phase 8 left a raise for 9B (contracts round 18 B14, round 19 item 16; `docs/runbooks/payroll-parallel-run.md`): the
annual statement and its `employee_ytd` dataset read the projection only, so a mid-year cut-over's statement omitted
`app.employee_ytd_opening`, and no production read path used `ytdFromEmployeeYtd`'s read-time addend.

### Built

- **`packages/db/src/reports/datasets/hr.ts`** — `employeeYtdDataset` reads the projection **plus** the opening: the
  union of both tables' `(company, employee, year)` keys, gross and net summed exactly as `ytdFromEmployeeYtd` sums them,
  and each scheme's employee/employer shares summed over the union of both `by_scheme` bags (a scheme only the opening
  carries appears; an employee with an opening and no posted run that year is listed with a null scheme). The id,
  the eleven columns, the read code (`hr.payroll.read`) and the registry (34) are unchanged; the opening's
  `by_component`, `source` and `loaded_by` are not read. **B14 holds**: `app.employee_ytd` is still written only by step
  12, and neither the MERGE nor the nightly rebuild reads the opening.
- **`packages/db/seed/my/reports/8d/hr.annual_statement.json`** — **`definitionVersion` 2**; the footer reads "From
  posted payroll lines plus the cut-over opening (spec:2084) … — من السطور المرحّلة والرصيد الافتتاحي؛ وثيقة داخلية".
- **The executed tie-out** (`tests/invariants/support/reports.ts`, arm `employee_ytd`) reads `app.employee_ytd` and
  `app.employee_ytd_opening` on its own, adds them as `Money` per (employee, year) and per scheme, and now also refuses
  a report scheme row the stored bags do not hold (both directions).
- **Tests**: `hr-datasets.test.ts` +1 (failed first: the dataset printed the projection alone) — openings written by
  8C's `upsertEmployeeYtdOpening` inside a rolled-back transaction: employee A's gross/net = projection + opening =
  `ytdFromEmployeeYtd`'s figure, EPF summed, an opening-only SOCSO row, employee B unchanged, the contractor listed from
  the opening alone, the projection still two rows. `hr-definitions.test.ts` +1 — the annual statement with openings
  still ties out (projection + opening), A's EPF 1250.0000/2500.0000, the contractor on the employer return, the footer
  names the basis. Version pins moved for this one code: `hr-definitions.test.ts` (the shipped-definitions case),
  `tests/invariants/report-catalogue-pins.test.ts`, `packages/db/test/seed/reports.test.ts` (versions `[1, 2]`; a
  fresh tenant holds the statement at version 2 only).
- **Records**: contracts round 20 **C18** (supersedes round 19 item 16's last sentence); the runbook's annual-statement
  paragraphs rewritten (what the statement carries since 9B, and the two limits that remain).
- **Found by the suite and fixed**: `docs/runbooks/cut-over.md` (T10) gave six seed commands without `APP_ENV`, which
  `packages/db/test/seed/tax-pack.test.ts` ("every seed command any runbook gives names its APP_ENV") refuses; each line
  now carries `APP_ENV=<staging|production>`.

### Deviations and choices

- **The dataset reads through the addend, not a new dataset**: 7A's review fixed a code's `dataset.source` across its
  versions, so `hr.annual_statement` cannot move to another source, and a new id would grow the closed registry.
- **Shares are added too** (beyond `ytdFromEmployeeYtd`, which adds only gross and net): the opening's `by_scheme` has
  the projection's shape, and a statement that added gross but not contributions would disagree with itself. 9B's
  loader writes `{}`, so today the legacy months' contributions are absent from the scheme columns — the runbook says
  so.
- **The version bump** follows the runbook's own rule for a statement edit (and 7B's envelope form: `definitionVersion`
  2, `definition.version` still the format's 1). A version-1 core row in an already-seeded tenant stays beside it and
  reads the same dataset; none exists outside test databases (OD-19/OD-20).

### For the phase close (AGENTS.md)

AGENTS.md's Phase 8 known-limit sentence — "the annual statement carries no cut-over opening (the `employee_ytd`
dataset reads the projection; `employee_ytd_opening` is a read-time addend no row carries until 9B), so a mid-year switch
must not issue that year's statement from Dulja alone" — should become:

> the annual statement carries the cut-over opening: since 9B the `employee_ytd` dataset adds `app.employee_ytd_opening`
> to the projection at read time (gross, net and each scheme's shares; contracts round 20 C18, B14 unchanged) and
> `hr.annual_statement` is at `definitionVersion` 2; but 9B loads only gross and net into the opening (§5.1 #11's
> statutory shares are unconfirmed, hazard 1), so a mid-year statement's scheme columns omit the legacy months'
> contributions, and the calculator still reads posted lines (`ytdFromPostedLines`), so the first Dulja run's PCB does
> not see the opening (spec:2084's "computes PCB correctly" is unmet for a mid-year switch)

T8's earlier proposed rewrite ("the `employee_ytd` dataset and `hr.annual_statement` read the projection only …") is
superseded by this one.

### Verification (2026-11-14, Linux, Node 22, PostgreSQL 18 Testcontainers)

- `packages/db`: `test/reports`, `test/hr`, `test/seed`, `test/export` — **77 files, 748 passed, 5 skipped, 2 failed**
  before the runbook fix; the two failures were `seed/tax-pack` (fixed above; 19/19 after) and
  `reports/7b-report-indexes` "a timezone date companion …", the pre-existing failure recorded at 9B T0–T2 (not 9B's).
  Focused: `hr-datasets` 18, `hr-definitions` + `seed/reports` + `hr-datasets` 55.
- `tests`: `invariants/report-tie-out`, `report-tie-out-7c`, `report-catalogue-pins`, `employee-ytd-rebuild`,
  `cut-over-reconciliation`, `hr-sensitive-side-channels`, `export-audit`, `projection-rebuild` — **8 files, 95 passed**.
- `apps/worker` `test/reports/render.test.ts` 18; `apps/api` `routes/accounting/report-runs` + `routes/hr/payslips` 41.
- `bun run typecheck`, `bun run lint`, `bun run lint:rules` (11 rules, 1,530 files, 0 violations),
  `bun run format:check`, all eighteen `scripts/check/*.sh` gates. No route or schema changed.

## 9B review — findings 1, 4, 5, 7 (2026-11-14)

An independent review of the Phase 9 change set (`git log dc907e5..1ec71fd`) raised these four; each was verified
against the code before it was fixed, and each fix landed with a regression test that failed on the code before it
(the worker and API cases were run against the previous handler/route and failed as described). Commits `e2486ed`
(1), `837bfa6` (4), `a1eb44f` (5), `45dd9b0` (7) and this records commit. Contracts round 20 **C19–C22**, ADR 0084
decisions **21–24** (Proposed, owner questions 6–7), decision rows in `docs/review/2026-11-13-phase-9-decisions.md`.

### Finding 1 (HIGH, confirmed) — any tenant could import the one configured legacy database

- `loadSourceFromEnv` read the process-wide `LEGACY_ODBC_DSN` with no tenant or company; the worker serves every
  tenant. **Fix:** `LEGACY_IMPORT_TARGET=<tenantId>:<companyId>` (`packages/importer/src/load/target.ts`:
  `ImportTarget`, `IMPORT_TARGET_ENV`, `importTargetFromEnv`, `assertImportTarget`, all in the barrel — the barrel pin
  grows by three). `LoadSourceFactory` now takes the target; `runLoad` passes `{ tenantId, companyId }`;
  `loadSourceFromEnv(target)` refuses before connecting; the handler asserts it for every run before the source is
  opened. New code **`ERR_IMPORT_SOURCE_NOT_BOUND`** (403) in `ERRORS`, `LoadErrorCode`, the contracts test pin and
  §4.2.4's registry. `containerSecrets(env, "worker")` passes the binding; `"api"` never.
- **The API does not refuse up front** (decision 21): it would need the binding threaded through `readConfig`,
  `createApp` and a frozen route const for a check the worker makes before any read. **CLI:** `load` and
  `reconcile-cut-over` must match the binding whenever the DSN is the environment's; `--dsn`/`--fixture` need none.
- Tests: `packages/importer/test/load/target.test.ts` (4), `cli.test.ts` (+1), `apps/worker` import-run (+1: another
  company, another tenant, unbound — the source never opened), `apps/edge` containers (+1).
- Runbooks: `cut-over.md` (step 0's `$env:LEGACY_IMPORT_TARGET`, step 2's worker binding, the final removal) and
  `deploy.md`.

### Finding 4 (MEDIUM, confirmed) — `admin.company.manage` alone posted ledger, stock and HR data

- **Fix:** `packages/db/src/import/gates.ts` — `IMPORT_LOADER_WRITE_CODES`, `importWriteCodes`,
  `unmappedImportTargets`, `missingImportWriteCodes` (`app.principal_has(…, company, null)`). `POST …/imports` refuses
  (403 `ERR_RBAC_FORBIDDEN`, each code named) a requester lacking any write code of an executed loader, `only`
  respected; the worker asks the same of `requested_by` at claim, before the source is opened, and fails closed on a
  registered loader with no row. Codes: masters/lots `inventory.item.manage`, accounts `accounting.account.manage`,
  parties `accounting.party.manage`, employees `hr.employee.manage` + `hr.compensation.manage` +
  `hr.employee.read_sensitive`, openings and open items `accounting.journal.post` / `inventory.receipt.post`, YTD
  opening `hr.payroll.post`.
- **Fresh-company guard** (`refuseForeignPostings` in `load/document.ts`) in `open_item` **and** `opening_balance`:
  T5's guard refused only a second opening, not one into a trading company, so it was not enough; opening stock's
  movement guard already was. `opening-stock.test.ts`'s "already holds stock" case now runs `only: ["opening_stock"]`
  (a full load stops first at the trial-balance opening's new refusal) and asserts both refusals.
- Tests: `packages/db/test/import/gates.test.ts` (4), importer `registry.test.ts` (+2), `open-items.test.ts` (+1),
  `apps/api` import routes (+1; every existing caller now granted the loaders' codes), `apps/worker` (+1).
- **For AGENTS.md (the list of widenings and tightenings):** a tightening from the 9B review — `POST
  /v1/companies/{companyId}/imports` keeps `admin.company.manage` as its gate but also asks the requester, at company
  scope, for the write code of every loader the run executes (`IMPORT_LOADER_WRITE_CODES`, `packages/db/src/import/
  gates.ts`; `only` respected), and the `admin.import.run` job asks the same of `requested_by` when it claims the run
  (ADR 0084 decision 22, contracts round 20 C20).

### Finding 5 (MEDIUM, confirmed) — a load longer than 4 hours ran twice and ended `failed`

- 7A/7C's `jobs/lease.ts` had no renewal. **Fix:** `renewLeased` (generic, row locked, throttled) and
  `renewImportRunLease`/`IMPORT_RUN_HEARTBEAT_SECONDS` (300); `LoadContext.heartbeat?` (C21) called by `runLoad` before
  every page's transaction; the worker renews there and throws `ClaimSuperseded` to stop — logging, recording nothing —
  once another claim holds the run. `expireInSeconds` stays the lease (a redelivery of a live job defers; a dead worker
  is redelivered after four hours). `IMPORT_RUN_LEASE_SECONDS`'s comment and `leaseJobOptions`' comment corrected.
- Tests: `packages/db/test/import/run.test.ts` (+1: fresh/renewed/superseded, a redelivery cannot reclaim a renewed
  claim); `apps/worker` (+2: a load whose claim is back-dated past the lease between pages renews and finishes
  `done` with `attempts: 1` while a takeover attempt gets `null`; a load whose run was reclaimed stops before page
  two, writing only page one's batch row). The lease is simulated by back-dating `started_at`, not by a short constant.

### Finding 7 (LOW, confirmed) — a run could stay `queued` for ever

- **Fix:** the busy refusal schedules a follow-up (`importRunBusyFollowUpOptions`, `IMPORT_RUN_BUSY_RETRY_SECONDS`
  300, key `<runId>:busy`) instead of throwing. `POST …/imports` calls `supersedeStaleImportRuns` after the write-code
  check: a run `queued` with `attempts = 0` older than the lease is failed with a stable `ERR_INTERNAL` reason as the
  requester; a claimed run is never touched; the 409's detail says so. **No new route** (the smaller correct fix).
- Tests: `apps/worker` (+1: a redelivery during a load resolves and leaves one follow-up due later; the load ends
  `done`), `apps/api` (+1: a stale queued run is superseded and the POST answers 202; a stale CLAIMED run still 409s).
- `openapi.json` regenerated: no diff (no route or schema changed).

### Verification (2026-11-14, Linux, Node 22, Bun 1.4, PostgreSQL 18 Testcontainers)

- `apps/api` full: **1,083 passed in 110 files**. `apps/worker` full: **165 passed in 23 files** plus its two Bun cases.
- `packages/importer` full: **339 passed, 2 skipped in 32 files** (OD-17's live cases). `packages/db`
  `test/import` + `test/jobs`: 6 files, 67 passed. `packages/contracts` 69, `apps/edge` 49.
- `tests`: `invariants/tenant-isolation`, `job-isolation`, `projection-rebuild`, `cut-over-reconciliation`,
  `lint-rules`, `regression/sah-049`, `-083`, `-084` — 8 files, 120 passed; after finding 4 also `sah-003`, `-007`,
  `-011`, `-022`, `-028`, `-051`, `-066`, `-073`, `-077` — 12 files, 82 passed.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`, all
  eighteen `scripts/check/*.sh` gates (the 9B gate with C19–C22's literals), `openapi.json` regenerated with no diff.
- **Not verified:** a deployed worker with a real binding (OD-17/OD-20), the whole `packages/db` and `tests` suites,
  Windows.

## 9B review — findings 2, 3, 6, 8 (2026-11-14)

The other four findings of the same independent review. Each was verified against the code before it was fixed (all
four held), and each fix landed with a regression test that failed on the code before it (run against the previous
source with `git stash -- src` and seen failing). Commits `ac5a78f` (6), `b9f7872` (8), `d955b46` (2), `1e52d29` (3),
`c0910d5` (the sibling corpus) and this records commit. Contracts round 20 **C23–C24**; ADR 0083 amended; ADR 0084
decisions **25–27** (Proposed, owner question 8); ADR 0086 decisions **8–9** (Proposed); decision rows in
`docs/review/2026-11-13-phase-9-decisions.md`.

### Finding 2 (HIGH, confirmed) — the anonymised snapshot copied prefixed personal columns in clear

- Verified: with the cut-over corpus's own catalogue, `planSnapshot` copied `EMPNATID`, `EMPDOB`, `EMPBANKACC`,
  `EMPEPFNO`, `EMPSOCSONO`, `EMPTAXNO`, `ACCTAXNO`, `EMPYTDGROSS`/`NET` and `PITGROSS`/`PITNET`, and `EMPNAME`,
  `EMPNAMEAR`, `ACCNAME` were not pseudonymised; the old tests passed only on unprefixed columns.
- **Fix** (`packages/importer/src/snapshot.ts`): every rule is a stem matched anywhere or after an optional
  three-letter prefix (person words that would catch a key, `STUDENTID`, anchored behind it); new kinds
  `date_of_birth` and `pay`, both **omitted**; **`PERSONAL_TABLES`** (every `salaries` table plus the shipped map's
  `…USERS`, `…PAYROLLS`, `…PAYITEMS`, derived from `LEGACY_MODULES`) **fail closed** — a column no rule recognises is
  omitted, only the table's primary key (`planSnapshot(table, columns, keys)`, `snapshot` passes
  `driver.keyColumns`) is copied. `PAYITEM_COLUMNS` is exported (package-internal) from `load/employees.ts` for the
  cross-check.
- Tests (`test/snapshot.test.ts`, +7): prefixed names/identifiers; DOB and pay omitted; fail-closed; **the
  cross-check** — every source column of every 9B loader, `mposLoader` and the payslip columns, planned with the
  corpus's keys: no `sensitive` column and none of the 22 named personal/pay columns is copied, and the copied set
  equals a reviewed list of 44 (a new loader column the rules would copy fails until reviewed); an end-to-end
  snapshot of `EMPLOYEES`, `PAYITEMS` and `ACCOUNTS` writes none of 30+ corpus secrets and keeps `EMPID` joinable.
  The existing `USERS` plan test now names its key.
- Docs: ADR 0083 amendment (the cost: an HR rehearsal against a snapshot sees keys and pseudonyms only, and a personal
  table without a declared primary key leaves without its key); `docs/runbooks/legacy-extraction.md`.

### Finding 3 (MEDIUM-HIGH, confirmed) — "reverse the opening and load again" could not work

- Verified: after a reversal every earlier key stays recorded (0102: no UPDATE/DELETE), so `runLoad` handed `load` only
  the new key; the guard passed because the prior opening was reversed. Failure modes A (one-account
  `OPENING_BALANCE` plus its own `3900` residue), B (stock replayed from a fragment — `opening-stock.test.ts` pinned
  this as intended: "loads again once the opening is reversed", docs `1 reversed, 2 posted, 3 posted`) and C (a
  reversal with no new key reloads nothing) all held. Reported stock positions were recorded against their
  warehouse's document or `EMPTY_TARGET` and never retried, contradicting `run.ts` step 4.
- **Fix — one-shot.** `refusePriorOpening` (`load/document.ts`) refuses `ERR_IMPORT_DUPLICATE_SOURCE_KEY` whenever any
  earlier run recorded a row of the loader — posted, reversed or `EMPTY_TARGET` — naming the run and the document
  and at most five new keys; the trial-balance opening and opening stock call it first. Opening stock's movement
  guard is simplified to "any stock movement refuses". Every "reverse" remedy is withdrawn: the openings',
  `refuseForeignPostings`' (a reversed document stands beside its reversal), `runLoad`'s changed-row conflict and
  `ERRORS.ERR_IMPORT_DUPLICATE_SOURCE_KEY.remedy`. **Reported positions are final**, stated in `run.ts`,
  `Loader.map`, `LoadResult.skips` and the runbook; `reconcileCutOver` now explains a stock row whose difference is
  exactly the value of positions the load **read** (every `BILLITEMS` row recorded under `opening_stock`) and did not
  **open** (no line on the load's own `OPENING_STOCK` documents), naming their skip-register keys, and the
  inventory-control row when recomputed − Dulja equals that sum. A position the source gained after the load stays
  unexplained (the existing grown-source case is unchanged).
- Tests: `opening-balance.test.ts` (+1: a grown source is refused after the reversal; the frozen source re-run loads
  nothing; the grown-source regex follows the new words); `opening-stock.test.ts` (the partial-replay case rewritten
  to refuse before and after the reversal and reload nothing; the back-dated case now asserts the one-shot refusal;
  +1: a reported position stays unopened after its missing item imports; the held-stock regex follows the new words);
  `reconcile-cut-over.test.ts` (+1: a never-imported material and a service, read and reported, are explained by the
  skip register and the `1300` row says so).
- Docs: `docs/runbooks/cut-over.md` (rehearse in a rehearsal company; never reverse an imported opening to reload it;
  which skips are retried and which are final; exit 4's remedy per loader kind; the stock section), ADR 0084 decisions
  26–27 and owner question 8, ADR 0086 decision 9 (narrows decision 5), contracts C24.

### Finding 6 (LOW-MEDIUM, confirmed) — YTD pay stored as an unsalted digest

- Verified: `import_batch.source_hash` for `YTD:<EMPID>` was `sha256({EMPID, EMPYTDGROSS, EMPYTDNET})`. ADR 0084
  decision 13 had accepted it ("`employee_ytd_opening` carries them under tenant RLS already"), true of the table but
  not of its readers: the figures are read only under `hr.payroll.read` (routes, dataset, export row), while
  `import_batch` is plumbing every loader's resolver reads.
- **Fix:** both columns `sensitive` (presence only), decision 13's two sentences withdrawn by decision 25. A keyed
  digest was rejected (every key rotation would turn each recorded row into a conflict). No other hashed HR column is
  money: the employee master's names and dates are stored in clear in `party`/`employee`, and `PAYITEMS` is never a
  loader source.
- Test: `employees.test.ts` (+1) pins the persisted digest of `YTD:5001` to the sealed form.

### Finding 8 (LOW, confirmed) — the drift report could never explain any of `3900`

- Verified: `aggregate_drift` read `ACCTOTALS(ACCOUNT, DEBIT, CREDIT)`; the trial-balance loader and the cut-over corpus
  spell it `ACTACC/ACTDEBIT/ACTCREDIT`, so both `ACCTOTALS` rules were `source_absent` on every loadable source.
- **Fix:** `AggregateRule.storedSpellings?` (`AggregateSpelling`; C23) and `firstSpelling` in `reconcile/probe.ts`
  (the first COMPLETE spelling the table has, never one column of each); a drift row read under a further spelling
  says so in its `derivation`. Same for `null_poison` (`ACTDEBIT`, `ACTCREDIT`, `BTMQNT`), `duplicate_aggregates`
  (`ACTACC`) and `orphans` (`BTMMAT`→`MATID`, `BTMWAR`→`WARID`). Not respelt (the 9B column is a different figure or
  table): `MATOBJECTS`/`MATQUANTITY` drift (`BTMQNT` is a magnitude beside `BTMIN`), `MATTOTALS`, `BILLITEMS.BATCH`
  (9B's `MATBATCHES`), `VOUITEMS.ACCOUNT`→`ACCOUNTS.ID` (a key-domain question, R29) and `employee_mapping`. The
  cut-over corpus's `VOUITEMS.ACCOUNT` (and `matopens-partitioned`'s copy) now carry the chart code `ACTACC` carries.
- Tests: `aggregate-drift.test.ts` (+6 in a new describe: drift, drift keyed by chart code with the derivation suffix,
  9A spelling preferred / neither → `source_absent`, null_poison, duplicates, orphans) and `reconcile-cut-over.test.ts`
  (+1: a stored total drifting 50 is loaded into a second tenant; the 8350 imbalance is explained by
  `aggregate_drift` 50 + `unbalanced_vouchers` 8300, `3900` −6130 decomposes to the cent). Two existing cases follow the
  corpus's account codes.

### For AGENTS.md (the list of widenings and tightenings, and the known limits)

- A tightening from the 9B review (finding 3): the trial-balance opening and opening stock are **one-shot**
  (`refusePriorOpening`); a reversal never reopens them; a full re-import goes into a fresh company.
- Known limit: a staging snapshot of a personal table carries only its primary key and pseudonymised columns.

### Verification (2026-11-14, Linux, Node 22, Bun 1.4, PostgreSQL 18 Testcontainers)

- `packages/importer` full: **357 passed, 2 skipped in 32 files** (OD-17's live cases; was 339 + 2).
- `tests`: `invariants/cut-over-reconciliation`, `lint-rules`, `type-resolution`, `regression/sah-003`, `-007`, `-011`,
  `-022`, `-028`, `-049`, `-051`, `-073`, `-077` — **12 files, 95 passed**.
- `apps/worker` `test/handlers/import-run.test.ts` 18; `packages/contracts` 69.
- `bun run typecheck` 15/15, `bun run lint`, `bun run lint:rules` (11 rules, 0 violations), `bun run format:check`, all
  eighteen `scripts/check/*.sh` gates (the 9B gate with C23–C24's literals). No route or schema changed, so
  `openapi.json` is untouched.
- **Not verified:** the whole `packages/db`, `apps/api` and `tests` suites; any live catalogue (OD-17) — which spelling
  and which `VouItems.Account` domain the customer's database holds; a snapshot of a real Firebird `EMPLOYEES`.
