# OD-17 — the live legacy database, the rehearsal, and the columns that become `verified`

**Status: open.** Contracts §2.12, OD-17; spec:2409, 2469 ("Read access to the live Sahlisoft database; Firebird
version"). §2.12's default: **none**. 9A's half (scope, profile, reconcile against the live source) is
`docs/runbooks/legacy-extraction.md`; this record is 9B's half, plan 9B Task 14 (2026-11-14). It decides nothing and
promotes nothing.

**Owner provides:** a read-only ODBC DSN for the live (or freshly restored) Sahlisoft database, and the Firebird version
if the engine does not report it (ADR 0081).

**Until provided:** every 9B test runs against the committed synthetic corpus `packages/importer/test/corpus/cut-over`,
and every declared source column of every loader is `confidence: "hypothesis"` — pinned by
`packages/importer/test/load/preflight.test.ts` ("with OD-17 unanswered, no declared column is verified"). Two
env-gated suites are skipped, never failed: 9A's `test/odbc.test.ts` and 9B's "the registered loaders against the live
catalogue (OD-17)" in `test/load/preflight.test.ts`. Dropping this task leaves the slice complete: it adds no code
path, only evidence.

**The spelling question the reading settles.** 9A's reports read some tables unprefixed (`ACCOUNTS.CODE`,
`VOUITEMS.ACCOUNT`, `MATOPENS.JOB`, `EMPLOYEES.NAME`) and 9B's loaders read them with the dossier's per-table prefix
(`ACCOUNTS.ACCCODE`, `ACCTOTALS.ACTACC`, `MATOPENS.MOPJOB`, `EMPLOYEES.EMPNUMBER`); both are hypotheses and the committed
`cut-over` corpus carries both. Whichever spelling the live catalogue lacks is corrected — by reading the catalogue,
never by renaming to fit a guess.

## The procedure (run in this order, on the machine that holds the DSN)

Set `LEGACY_ODBC_DSN` in the environment, never on a command line (`docs/runbooks/cut-over.md` step 0), and run
`bun pm trust odbc` once.

1. **Scope.** `bun run legacy scope --out artefacts/legacy/scope` prints an engine version, a table count and a total
   row count, and writes `scope.json` (9A).
2. **Pre-flight against the live catalogue.**
   `bun run --cwd packages/importer test test/load/preflight` — with `LEGACY_ODBC_DSN` set, the live case runs: it
   prints one `finding:` line per declared column the catalogue lacks and one `confirmed:` line per declared
   `TABLE.COLUMN` it has, and passes only with **zero required-column findings**. It reads the catalogue and nothing
   else, and needs no Dulja database. Then, against a rehearsal tenant:
   `bun run legacy load --tenant-id <id> --company-id <id> --cut-over-date <date> --account-map <path> --dry-run`
   writes `preflight.json` with the same findings (`docs/runbooks/cut-over.md` step 3).
3. **Reconcile.** After a rehearsal load,
   `bun run legacy reconcile-cut-over --tenant-id <id> --company-id <id> --cut-over-date <date> --account-map <path>`
   exits 0.
4. **Promote exactly the confirmed columns.** For every `confirmed:` line of step 2 — read from that output or from
   `scope.json`, never from memory — change that column's `confidence: "hypothesis"` to `confidence: "verified"` in
   its loader under `packages/importer/src/load/`. A column the catalogue lacks is **not** renamed to match a guess: it
   is removed from its loader's `sourceColumns`, its field is not loaded, and that loader's test asserts the resulting
   skip or refusal.
5. **Record the reading in ADR 0084**, in the same commit, as a new section:

   ```markdown
   ## Consequences (appended <date>, OD-17)

   The live catalogue was read on <date> from `<redactDsn output>`, engine `<engineVersion>`, and the following
   declared columns were confirmed present with the declared table:

       UNITS.UNTID, UNITS.UNTNAME, …

   Every one of them is now `confidence: "verified"` in its loader. Columns absent from the live catalogue were NOT
   renamed to match a guess — each was removed from its map and its field is not loaded.
   ```

   Paste only `redactDsn`'s output, never the DSN; no customer value enters the repository (`artefacts/legacy/` is
   git-ignored). In the same commit, delete the pinning case "with OD-17 unanswered, no declared column is verified"
   from `test/load/preflight.test.ts`; its neighbour "none is verified without an ADR 0084 line" then fails for any
   promoted column the section does not name.
6. **Re-run everything:** `bun run --cwd packages/importer test`,
   `bun run --cwd tests test invariants/cut-over-reconciliation`, `bun run lint`, `bun run typecheck`. A `confidence`
   change is metadata pre-flight prints, never a branch, so the corpus tests are unaffected.

Implementation authorization for the default: `docs/review/2026-11-13-phase-9-decisions.md`, row "9B T14".
