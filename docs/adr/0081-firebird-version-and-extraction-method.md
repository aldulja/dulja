# 0081 — Firebird version and extraction method

- Status: **Proposed** — its three decisions are the owner's answers to OD-17 and are filled in when the scoping run
  has been executed against the live database (9A Task 3 Step 9); the status becomes _Accepted_ then. The code
  that run uses is built ahead of the answer, under the owner's direction to implement Phase 9 entirely
  (2026-11-13; `docs/review/2026-11-13-phase-9-decisions.md`).
- Date: 2026-11-13 (the plan's text is dated 2026-09-05)
- Slice: 9A · Task 3
- Owner gate: **OD-17** (spec:2409, 2469; Part VII #5). Contracts: §2.12, §4.13.1, hazard 3.

## Context

Part VII #5 is open: "Firebird version in production. Determines whether the UDF path still works and how data can
be extracted (`gbak` vs ODBC vs direct file read)." Nothing in the shipped files answers it, and contracts hazard 3
forbids any plan from assuming an answer.

## Options

| Method | What it is | Cost to the owner | Risk |
|---|---|---|---|
| Read the live database over ODBC | a read-only connection to production | none beyond a user account | read load on production during business hours |
| `gbak` backup, restore into a throwaway instance, read that over ODBC | the standard Firebird backup path | one backup window | needs a machine and disk for the restore |
| Copy the `.fdb`, attach it locally, read over ODBC | file copy | a maintenance window (the file must be quiescent) | a copy taken while the engine is writing is not restorable |

**All three terminate at one SQL connection.** The method changes the runbook — who takes the copy, on which
machine, with what downtime — and not `OdbcLegacyDriver` (`packages/importer/src/drivers/odbc.ts`), which is why
9A ships one live driver.

## What is built now

- `connectOdbc({ dsn, firebirdVersion? })` opens the connection, importing the native `odbc` module lazily; the
  machine that runs the extraction builds its binding once (`bun pm trust odbc`), since the repository does not
  trust its install script.
- `engineVersion()` asks `rdb$get_context('SYSTEM', 'ENGINE_VERSION')` (Firebird 2.1 and later) and returns
  `null` when the engine raises or answers nothing; an owner-declared `--firebird-version` replaces the probe. Task
  4's `createReader` refuses to exist without one of the two. Nothing is inferred from the ODBC driver string or
  from the presence of a system table.
- `bun run legacy scope --dsn <dsn>` (or `--fixture base`, the local equivalent) writes
  `artefacts/legacy/<date>/scope.json`: row counts and date ranges per table, and the difference against the
  shipped 460-table map in both directions. It exits 2 when the engine does not report a version and none was
  declared, 3 when the source cannot be read. `odbc.test.ts`'s live case runs only when `LEGACY_ODBC_DSN` is set.

## Decision

- **Extraction method:** _record the method the owner's environment permits, and why._
- **Engine version:** _record the string `rdb$get_context('SYSTEM','ENGINE_VERSION')` returned, or, if the
  engine is older than 2.1 and raised, the version the owner supplied with `--firebird-version`._
- **UDF path:** _record whether the legacy UDF library is still resolvable, since it decides whether stored
  procedures could be run at all — 9A runs none, and 9B must not start._

## Consequences

- Recorded here, consumed by 9B's cut-over runbook.
- If the engine predates 2.1 the version is owner-supplied and this ADR is the only record of it; every artefact
  header carries it, so a report can never be read against the wrong source.
- The artefact is customer data and is never committed (`.gitignore` carries `artefacts/`); this ADR is.
