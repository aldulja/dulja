# Runbook — extracting and profiling the legacy database (Phase 9A)

Plan 9A Task 14; ADRs 0081 (Firebird version and extraction method), 0082 (how statements are built) and 0083
(artefacts and anonymisation) — all three **Proposed**. This runbook produces the evidence the owner needs to answer
OD-16, OD-25 and OD-27, and the numbers that size the Phase 1 and 3 load tests (spec:2267). It **loads nothing into
Dulja** — that is 9B — and it only ever issues `select` against the legacy database (ADR 0082).

## What the owner provides

| Item | Ledger | Why |
|---|---|---|
| A read-only ODBC DSN for the main legacy database | OD-17 | every command below |
| The Firebird version, if the engine is older than 2.1 | OD-17 | `LegacyReader.firebirdVersion` is required and is never inferred (ADR 0081) |
| A second DSN for the `mpos` database — **only if** historical POS data must migrate | OD-16 | `--mpos`; the default is to start the new POS clean |
| The answers, once the artefacts are read | OD-16, OD-25, OD-27 | the tool reports evidence and decides nothing |

A database user that can only `SELECT` is preferred (ADR 0082's owner question).

## Preparing the machine (once)

The extraction runs on the owner's Windows machine — or any machine with the Firebird ODBC driver installed and
network access to the database — from a checkout of this repository with Bun 1.4:

```powershell
bun install
# The `odbc` package is a native module whose install script the repository does not trust (CI has no ODBC
# driver manager). Build its binding here, once. Without it every live command exits 3 and says so.
bun pm trust odbc
```

**Never put a DSN on the command line.** `bun run` echoes its whole command line before it runs, so a password inside
`--dsn` or `--mpos-dsn` is printed to the terminal (and to any log capturing it). Set the variables instead; the CLI
reads `LEGACY_ODBC_DSN` whenever `--dsn` is absent, and `LEGACY_MPOS_DSN` under `--mpos`:

```powershell
$env:LEGACY_ODBC_DSN = 'DRIVER={Firebird/InterBase(r) driver};DBNAME=<host>:<path>\STANDARD.FDB;UID=<user>;PWD=<password>'
# Only if OD-16 is being answered:
$env:LEGACY_MPOS_DSN = 'DRIVER={Firebird/InterBase(r) driver};DBNAME=<host>:<path>\MPOS.FDB;UID=<user>;PWD=<password>'
```

(`export LEGACY_ODBC_DSN='…'` in a POSIX shell.) `LEGACY_MPOS_DSN` is CLI-only and never reaches a container; since 9B,
`LEGACY_ODBC_DSN` also reaches the **worker** — never the api — and only while a cut-over is bound (contracts §3.11,
round 20 C10; `docs/runbooks/cut-over.md`).
Every DSN that reaches an artefact header or an error line has its `UID`/`PWD` replaced by `***` (`redactDsn`), a
brace-quoted value (`PWD={a;b}`) whole. Every option is written `--key value` or as a bare `--switch`; the CLI refuses
`--key=value`, an option the command does not read and an empty value with exit 2 (2026-11-15 review, HRP-05–07).

**Verify the access before anything else:**

```powershell
bun run legacy scope --out artefacts/legacy/scope
```

prints `engine: <version>`, a `tables:` line and a `rows:` line, writes `scope.json`, and ends
`mpos: not read (OD-16 default: start clean)`. If the engine does not answer `ENGINE_VERSION` the command exits **2**
and says to pass `--firebird-version <string>`; that string is what ADR 0081 records.

**Until the owner provides a DSN**, every command below runs identically against the committed synthetic corpus by
adding `--fixture base` (or `--fixture questions` for `questions`), and prints the same lines with the corpus's own
numbers. No step of this runbook is blocked on the owner; only the _answers_ are.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | the artefacts were written | read them |
| 2 | a configuration mistake: an unknown command or `--kind`, no source named, a `--fixture` not on disk, `--mpos` with `LEGACY_MPOS_DSN` unset, or an engine that reports no version | the message names the fix |
| 3 | `ERR_IMPORT_SOURCE_UNREADABLE`: the source cannot be opened or read as asked — no native binding, an unreachable DSN, a table or column the catalogue does not declare | the message names the table, the column or the binding |

A failed run writes no `index.json`, so a half-written directory is never mistaken for a finished one.

## Taking the extract

Which of the three methods Part VII #5 lists — reading production directly, restoring a `gbak` backup into a
throwaway instance, or attaching a copied `.fdb` — is recorded in ADR 0081. **The code is the same in all three**;
the choice is about who takes the backup, on which machine, and with what downtime. Prefer a restored backup: the
reader only ever issues `select`, but a read against a live accounting database during business hours is a risk with
no upside.

## The order, and why

1. `scope` — row counts and date ranges per table. §5.1 #10: "scope first, migrate second." Nothing else runs until
   somebody has looked at this file: it is what says whether the hospital (50 tables), academy (44) and aviation
   modules are dead weight (Part VII #1).
2. `profile` — the same numbers plus `modulesInUse`, in the frozen §4.13.1 shape 9B consumes. The `mpos` tables are
   left out unless `--include-mpos` (OD-16).
3. `reconcile` (`--kind all`, the default) — the six reports of §5.1 #1–#5 and #12. **Read `aggregate_drift`
   first**, and read `duplicate_aggregates` beside it: a duplicated key makes the stored figure wrong by exactly the
   excess. `employee_mapping` carries employee names in clear (ADR 0083); the console prints counts only.
4. `templates` — every report definition out of `System.Reports` as a hashed file under `templates/` (§5.1 #9,
   LEGACY-077), with `templates.csv` naming each one's group, owner and near-duplicates. Presence is not usage.
5. `questions` — the OD-27 evidence for Part VII #6, #7, #8, #9 and #13. Five lines, each ending
   `verdict: owner (OD-27)`.

Or all five at once, into one directory with one `index.json`:

```powershell
bun run legacy all
```

(the default output is `artefacts/legacy/<today>`; `--out <dir>` names another). If the source has no `REPORTS`
table, `all` prints `templates: skipped — …` and carries on; `questions` then reports Part VII #8 as
`unanswerable_here`. To answer OD-16 in the same run, set `LEGACY_MPOS_DSN` and add `--mpos`: the POS database is
opened on its own connection and `mpos-decision.json` carries its ticket count and date range, the question verbatim
and `answer: null`. `bun run legacy scope --mpos` does the same beside `scope.json`.

## The staging snapshot

Separate, and deliberately not part of `all`:

```powershell
bun run legacy snapshot --tables ACCOUNTS,MATERIALS --out artefacts/legacy/snap
```

Every column whose name classifies it as personal — a name, an identifier, a contact, an address, in the legacy
prefixed spelling (`EMPNAME`, `EMPNATID`, `ACCTAXNO`) as well as the bare one — is replaced by a pseudonym
(`HMAC-SHA256` under a per-run salt that is **never written**, truncated to the length of the value it replaces);
free text, blobs, credential-shaped columns, dates of birth and pay figures (`…YTD…`, `…SALARY…`) are omitted;
`Users.Password` and `Users.PIN` are never selected at all. **In a table of personal data** — every `salaries` table
(`EMPLOYEES`, `PAYITEMS`, `PAYROLLS`, …) and the user and payroll tables elsewhere — a column no rule recognises is
**omitted**, and only the table's primary key is copied (ADR 0083, the 9B review's amendment). So a staging rehearsal
of the HR loaders against the snapshot has no hire date, payroll number or payslip figure: rehearse HR against the
live source on this machine, in the rehearsal company. **Read `snapshot-plan.csv` before the
snapshot leaves the customer's premises**: it lists every column and what was done to it, and a column the rules
copied that is personal in this customer's data must be added to the rules before the snapshot is taken again.
Without `--tables` every table is snapshotted. This is what seeds `staging` (spec:2272); 0C's staging seed consumes
it, and nothing in this phase writes to `packages/db/seed/`.

## What the owner does with the artefacts

- **OD-25** (9B's gate): `unbalanced_vouchers.csv` gives each unbalanced voucher's signed imbalance and the
  population's totals. The owner agrees the suspense treatment _before_ migrating (§5.1 #2). The account is `3900`
  whatever they decide.
- **OD-16**: `mpos-decision.json`, if `--mpos` was given, carries the ticket count and date range.
- **OD-27**: `open-questions.csv`. Every `verdict` column is empty on purpose — the owner's answer is recorded
  against OD-27, not by this tool.
- **§5.1 #12**: `employee_mapping.csv` lists every unmatched employee row by name for the owner to decide.

## Handling the artefacts

`artefacts/` is in `.gitignore` and **is never committed** — the files are customer data. Keep them where the
customer's own backups are kept (ADR 0083's owner question 1 asks whether that suffices), and when the owner signs
off a figure cite **that artefact's `sha256` as `index.json` records it** — not `index.json`'s own entry, whose
digest is empty because a file cannot carry the hash of its own bytes (ADR 0083 §2) — so months later 9B's cut-over
can prove which file was agreed. Clear `LEGACY_ODBC_DSN` and `LEGACY_MPOS_DSN` from the shell when the run is done.
