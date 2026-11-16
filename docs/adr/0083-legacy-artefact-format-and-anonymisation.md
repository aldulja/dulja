# 0083 — Legacy artefacts: format, hashing, and what may leave the customer's machine

- Status: **Proposed** — the plan wrote _Accepted_; decisions 4 and 5 govern where credentials and personal data
  from the owner's production database may go, which is security (spec:95), so it waits on the owner like every
  other Phase 9 ADR of that kind. Decisions 1–3 are implemented in 9A Task 5 as the plan's default, ahead of
  approval, under the owner's direction to implement Phase 9 entirely (2026-11-13;
  `docs/review/2026-11-13-phase-9-decisions.md`); decision 5 is implemented by Task 14.
- Date: 2026-11-13 (the plan's text is dated 2026-09-05)
- Slice: 9A · Task 5
- Contracts: §4.13.1 (the artefact format — `ArtefactIndex`, `ArtefactEntry`, `ReportWriter`, `toCsv`). Supersedes:
  none.

## Context

9A produces a dozen reports the owner and their accountant must read, argue about, and later point at ("the
reconciliation we signed off"). It also produces the anonymised snapshot spec:2272 requires for staging. None of it
is a database row: contracts §4.11's `ReportDefinition` is Phase 7's engine over `report_definition`, and nothing
here is per-tenant data in Dulja — it is customer data from a system Dulja is replacing.

## Decision

1. **Every report is written as `<name>.json`** (machine-readable, the shape a later task consumes) **and, where a
   person reads it, as `<name>.csv`** — UTF-8 **with a BOM**, RFC 4180, CRLF, so Excel on Windows renders Arabic
   master-data names instead of mojibake (SAH-085 in reverse). Because the CSV is for a person, a cell a
   spreadsheet would evaluate as a formula (a leading `=`, `+`, `-`, `@`, tab or CR — OWASP "CSV injection") is
   prefixed with `'`, the 7A report-CSV rule (`packages/db/src/hr/csv-cell.ts`), restated in
   `packages/importer/src/artefacts.ts` because this package may not import `@dulja/db`. A plain signed decimal
   (`-50.0000`) is exempt: it is a figure, and a prefix would corrupt it. The JSON beside it is never neutralised.
2. **Every artefact is hashed with sha256 and listed in `index.json`**, which also carries `generatedAt` (UTC, to
   the second), the redacted `source` and the `engineVersion`. A report can never be read against the wrong source
   or the wrong engine, and 9B's cut-over runbook can cite a hash. `index.json` **lists itself** so the file is a
   complete manifest of the run; its own entry carries `bytes: 0` and an **empty** `sha256`, because a file
   cannot contain the digest of its own final bytes. Whoever needs to pin the manifest itself hashes `index.json`
   externally; every artefact listed inside it carries a real digest, taken over exactly the bytes written.
3. **Artefacts are written under `artefacts/legacy/<name>/` and are never committed** — `.gitignore` carries
   `artefacts/`. They contain customer data. An artefact name is a plain relative name: `ReportWriter` refuses an
   absolute name, a name that climbs out with `..`, and the index's own name, because later tasks write names
   derived from legacy data (a report template's) and such a name must not land outside the ignored directory.
4. **No credential ever reaches an artefact or a log line.** `redactDsn` replaces `UID`/`PWD`/`USER`/`PASSWORD`
   values with `***` before the DSN is stored in any header (spec:2063's forbidden-field rule, extended to this
   package by hand because `forbidden-log-fields` inspects logger call objects and this is a plain string).
5. **The anonymisation rule for the staging snapshot** (Task 14): every column classified as a personal identifier
   is replaced by a deterministic pseudonym `HMAC-SHA256(salt, table||column||value)` truncated to the column's
   declared width, with a per-run random salt that is **not** written to the artefact directory — so the mapping
   cannot be reversed from the snapshot, and two rows that shared a value still share one. `Users.Password` and
   `Users.PIN` are on a **deny-list**: they are not pseudonymised, they are never read. _(Amended by the 9B review,
   finding 2: the rules match prefixed columns, a birth date and a pay figure are omitted, and a table of personal
   data fails closed — see Consequences.)_

## Consequences

- A later phase that wants one of these numbers inside Dulja must load it as data through 9B; nothing here becomes
  a `report_definition`, a `DatasetId` or a route.
- The CSV's BOM makes the files unusable as input to a naïve UTF-8 parser, and the formula prefix means a CSV cell
  is not always the raw value. The JSON is the machine input; the CSV is for a person.
- **The `employee_mapping` report (9A Task 11) carries employee names in clear**, because the owner decides each
  unmatched row by name. It is held to decisions 1–4 and to data minimisation: it reads only `SITE`, `ID`, `NAME`
  and `ACCOUNT` from `EMPLOYEES` (no salary, no identifier, nothing else an HR row holds) and only the accounts
  flagged `IsEmployee` (the predicate is bound in the read, so the names of customers and suppliers never leave
  the legacy database for it); its row keys are `SITE|ID`, never a form a spreadsheet reads as a date; and the
  CLI prints only its summary counts, never a name (tested). Decision 5's pseudonymisation applies to the staging
  snapshot, not to a report the owner reads; there, Task 14's column rules pseudonymise a `NAME` column,
  `EMPLOYEES.NAME` and `ACCOUNTS.NAME` included.
- **Amended by 9A Task 14 (correction C4).** §5's "truncated to the column's declared width" reads, as implemented,
  "truncated to the length of the value it replaces". `LegacyColumn` carries no declared width and widening it
  would change a shape 9B reads; the value's own length is a stricter bound and needs no catalogue column. A value
  shorter than eight characters yields a pseudonym with a real collision probability, and the snapshot plan says so
  on that column's row rather than silently lengthening it.
- **As built by 9A Task 14.** The column rules are ordered and match on column names; a blob, a credential-shaped
  name and free text are omitted, a name, an identifier, a contact or an address is pseudonymised, anything else is
  copied — and `snapshot-plan.json`/`.csv` list every column's treatment and why, beside the data. An omitted
  column never reaches the `SelectSpec`, so a denied value is never selected (tested by recording every read), and
  a table with no column left to copy is counted, not read, because an empty column list means "every column" to a
  driver. The salt is `randomBytes(32)` per run and is written nowhere (tested by searching every file the run
  wrote). The snapshot is never part of `bun run legacy all`.
- **No DSN on a command line.** `bun run` echoes its whole command line, so a password passed as `--dsn` or
  `--mpos-dsn` is printed. The runbook sets `LEGACY_ODBC_DSN` (read when `--dsn` is absent) and, for OD-16,
  `LEGACY_MPOS_DSN` (read only under the explicit `--mpos` switch — the variable alone reads nothing, OD-16's
  default being to start clean). Every DSN that reaches an artefact header or an error line passes `redactDsn`.

- **Amended by the 9B review, finding 2 (2026-11-14), Proposed.** The column rules were anchored on bare words
  (`^name$`, `nationalid`, `bankaccount`), but the dossier's one verified naming fact is a per-table prefix on every
  physical column, and 9B reads `EMPNAME`, `EMPNATID`, `EMPBANKACC`, `EMPEPFNO`, `EMPTAXNO`, `ACCTAXNO`,
  `EMPYTDGROSS` and `PITGROSS`: none matched, so a snapshot of the real `EMPLOYEES`, `ACCOUNTS` or `PAYITEMS` copied
  every name, national id, bank account, scheme and tax number and pay figure in clear into a file meant to leave
  the customer's premises. As amended: (a) every rule is a stem matched anywhere in the name or after an optional
  three-letter prefix, with the person words that would catch a key column (`STUDENTID`) anchored behind that
  prefix; (b) two kinds are added and **omitted**, never pseudonymised — `date_of_birth` (`…DOB`, `…BIRTH…`) and `pay`
  (`…YTD…`, `…SALARY…`, `…WAGE…`, `…PAYSLIP…`) — because a pseudonym of a date or an amount is not one, and both are
  quasi-identifiers; (c) **the snapshot fails closed in a table of personal data** — every table of the `salaries`
  database and the shipped map's `…USERS`, `…PAYROLLS` and `…PAYITEMS` tables, taken from `LEGACY_MODULES`
  (`PERSONAL_TABLES`): a column no rule recognises is **omitted**, and only the table's own primary key
  (`LegacyDriver.keyColumns`) is copied, so its rows stay countable and joinable. Elsewhere an unrecognised column
  is still copied, because a staging seed with every unfamiliar code, quantity and date blanked rehearses nothing.
  Fail-closed everywhere was rejected for that reason; fail-open in a personal table was the defect. **The cost:** a
  staging rehearsal of the HR loaders against a snapshot sees only the keys and pseudonymised columns of those
  tables (no hire date, no payroll number, no payslip figure), and a personal table the live catalogue declares no
  primary key for leaves without its key; the HR load is rehearsed against the live source on the owner's machine,
  in the rehearsal company (`docs/runbooks/cut-over.md`). **The check that keeps it so:** `test/snapshot.test.ts`
  plans every source column every 9B loader declares (the unregistered historical POS loader and the payslip columns
  the YTD reconciliation reads included) and asserts that no `sensitive` column and no personal or pay column a
  loader names is copied, and that the set it does copy equals a reviewed list — a new loader column the rules would
  copy fails until a person adds it to that list.

## Owner questions

1. Is a git-ignored directory on the machine that ran the command an acceptable home for customer-data artefacts,
   or must they go straight to encrypted storage the owner names?
2. Decision 5's pseudonymisation (Task 14) — is a per-run salt that is discarded acceptable, given that two
   snapshots then pseudonymise the same value differently?
