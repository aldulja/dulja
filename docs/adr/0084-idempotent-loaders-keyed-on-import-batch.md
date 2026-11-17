# 0084 — Idempotent loaders keyed on `import_batch`, with declarative source columns

- Status: **Proposed** — the plan wrote _Accepted_; decisions 1, 2 and 7 decide how a customer's books enter the
  data model and when a legacy key's mapping is fixed for ever (spec:95's data-model class), so it waits on the owner
  like every other Phase 9 ADR of that kind. Implemented in 9B Task 3 as the plan's default, ahead of approval, under
  the owner's direction to implement Phase 9 entirely (2026-11-13; `docs/review/2026-11-13-phase-9-decisions.md`).
- Date: 2026-11-13 (the plan's text is dated 2026-09-08)
- Slice: 9B · Task 3
- Contracts: §4.13.2 (`Loader`, `LoadContext`, `RefResolver`, `loaders`, `runLoad`) with round 20's C8, C9, C12–C15;
  §4.13.3 and §4.6.1 (`app.import_batch`, C7). Supersedes: none.

## Context

The Phase 9 load runs against a customer's frozen Firebird database, over hours, on a machine that may lose its
connection. It runs more than once — a dry run, a rehearsal and the real cut-over (§5.1 #10) — so it must be
restartable without double-loading. LEGACY-049 says the source itself holds duplicate aggregate rows, so "insert
everything again and let the unique keys sort it out" would hide both real duplicates and real changes.

Three constraints shape the design. Hazard 3: no legacy table's column list is confirmed, and a TypeScript row
interface would make a guess look like a fact. §0.2: nothing outside the posting service writes a ledger or movement
row, so loaders write master data and build documents, never post. And migration 0102: `app_rw` holds no UPDATE on
`import_batch`, so "a legacy key's mapping never moves" is the data layer's rule, not only the service's.

## Decision

1. **`app.import_batch` is the idempotence ledger.** One row per `(company_id, source_table, source_key)` recording
   `target_table`, `target_id`, the run and a `source_hash` — the sha256 of exactly the columns the loader declared,
   a declared column the source lacks hashing as NULL. A key an earlier run recorded with the same hash is a silent
   skip, and `map` is not called for it; with a different hash, or under another target table, the run refuses with
   `ERR_IMPORT_DUPLICATE_SOURCE_KEY` naming the key.
2. **The check comes first and the batch row last, in one transaction per page.** Per source row: the key and its
   hash, the in-run duplicate check (decision 8), `findBatch`, then `map`. Every mapped row of the page goes to
   `load`, and only then is each row's `import_batch` row written with the target id `load` answered — in the same
   `withTenant` transaction. A changed source is therefore refused before anything of its page is written, and a
   committed batch row always names the row its key became. (The plan wrote a placeholder batch row first and filled
   its target in afterwards; with UPDATE revoked by 0102 that is impossible, and it bought nothing the order above
   does not.) A `recordBatch` that finds the key taken after `findBatch` did not — another load of the company
   committed it meanwhile — refuses the page whole.
3. **Every loader declares its source columns as data** (`SourceColumn[]`: `required`, `confidence`, a `note`), and
   `preflight(driver, loaders)` checks them against the customer's own catalogue (`LegacyDriver.columns()`) before
   one row is read. A missing required column, or a missing source table, is a named failure; a missing optional
   column is a finding, is not read, and maps as NULL. No per-table row interface is written anywhere in Phase 9.
4. **Pages of 500 (`READ_BATCH`).** One `withTenant` transaction per page, so a large table never holds a transaction
   open (spec:1368) and a failure leaves every completed page committed and recorded. A run is resumed by running
   the same command again; nothing is undone by hand.
5. **A dry run writes nothing.** It performs every read, check and `map` and never calls `load`. Its `inserted` is
   the count of rows that MAPPED — an upper bound on a real run's, because what `load` itself skips is known only by
   running it. (No rollback sentinel is needed: with decision 2's order nothing is written before `load`.)
6. **Two loaders are exempt from paging.** `Loader.wholeTable` (C13) makes `runLoad` map every page and call `load`
   once, in one transaction. The trial-balance opening and the stock replay set it, because a residue posted to one
   suspense line and a moving average over a whole history are not decomposable by page — and neither failure would
   show on a fixture smaller than a page. Their input is held in memory and commits once, so a crash rolls the whole
   opening back; half an opening balance is not a smaller one.
7. **A committed all-zero `target_id` (`EMPTY_TARGET`) means "seen; produced no target row".** It cannot mean a crash
   — decision 2 writes no placeholder — so a loader returns it deliberately (Task 6, for a warehouse whose history
   nets to zero; any loader, for a row whose reason it reports through C15's `skips`). Such a row is never retried,
   since its hash is unchanged on a re-run; correcting a dependency alone does not re-open it, and the runbook says
   so.
8. **A key met twice in one run is a duplicate in the source (LEGACY-049).** The run remembers each key and hash per
   loader. A second identical sighting is loaded once and reported in the skip register; a second sighting with
   different data refuses the run — across a page boundary and in a dry run alike, because the memory is the run's
   and not the database's. The cost is a key and a hash per source row in memory while that loader runs.
9. **The resolver reads only `import_batch`, and takes its source table from the registry.** §4.13.2's
   `byLegacyRef(table, legacyRef)` names only the target; the source table is the one the registered loader of that
   target reads. The registry is the one place the pairing is written, so it cannot drift from a second list (the
   plan's `SOURCE_OF`), and one target table has exactly one loader (`orderLoaders` refuses two). A target no loader
   produces resolves `null`, which the calling loader reports as an orphan.
10. **The legacy connection and the company's base currency are run-scoped ports.** §4.13.2 freezes
    `runLoad(sql, ctx)` at two parameters, so the source comes from `setLoadSource` / `loadSourceFromEnv`
    (`LEGACY_ODBC_DSN`) — 7A's `setObjectStore` shape — and `baseCurrency()` is read once from `app.company` when the
    run opens, because `map(row, refs)` has no `LoadContext` and must still mint `Money` in the tenant's currency.
    Both throw outside a run, and a second concurrent run in one process is refused.
11. **One scalar boundary.** `requireText`, `optionalText`, `moneyOf`, `quantityOf`, `dateOf` and `optionalDateOf` are
    where legacy text becomes a Dulja type. A NULL amount or quantity is refused, never read as zero (LEGACY-007,
    LEGACY-011); a decimal may carry any number of fraction digits or an exponent (a Firebird `float` cast to text) and
    is rounded once, HALF_AWAY_FROM_ZERO, at the column's scale, through the domain's one `round`; a value
    numeric(19,4) or numeric(19,6) cannot hold is refused; a date is a real calendar date or a refusal.
12. **Every refusal names itself and leaves evidence.** `LoadError` carries `ERR_IMPORT_DUPLICATE_SOURCE_KEY`,
    `ERR_IMPORT_UNBALANCED_SOURCE` (Task 5), `ERR_IMPORT_SOURCE_UNREADABLE` or `ERR_VALIDATION_FAILED` as a field —
    `packages/importer` may not import `AppError` (§3.1). A refused run writes `load-failed.json` and the artefact
    index beside `preflight.json`; a completed one writes `preflight.json`, one `loader-<target>.json` per loader,
    `load-summary.json` and `skips.csv` under `artefacts/legacy/<runId>/`, every entry hashed (C9).

## Consequences

- A cut-over that fails half way is resumed by re-running the same command; `only` (C14) restricts a resume to named
  target tables, in dependency order, and a name no loader targets is refused rather than read as "nothing to do".
- A source that moved after the freeze is loud: the operator is told which key changed, never handed a silently
  different tenant.
- The column map is reviewable: `sourceColumns` says what each loader believes, which is the artefact §5.1 #10's
  "scope first" is for.
- The importer CLI's `load` command and Task 9's `admin.import.run` job call the same `runLoad` as the tenant's
  system principal. The CLI exits 0 for a clean load, 1 for a load with skips, 2 for a configuration mistake or a
  refusal, 3 when the source cannot be read or fails pre-flight.
- The importer's own suites now include PostgreSQL-backed ones, so the workspace runs in CI's Linux `database` job
  rather than the Windows `checks` job.
- **This ADR records no legacy column as `verified`.** The first live `scope` run under OD-17 (Task 14) is what
  promotes a column, and this ADR gains a Consequences line recording that reading when it does.

## Questions for the owner

1. Decision 8 refuses the run on a key the source holds twice with different data, where the plan's text would have
   refused only across runs. Is a refusal right for a legacy table whose key is not a key, or should such rows be
   skipped and reported, leaving the operator to choose between them?
2. Decision 7 means a row recorded against `EMPTY_TARGET` is never retried. Is "open it from the reconciliation, or
   reload into a clean tenant" the remedy the owner wants for a position whose dependency was corrected later?

## Amendment — 9B Task 8 (2026-11-13), Proposed

13. **A `sensitive` source column enters the persisted hash as presence only.** `SourceColumn.sensitive` marks a
    value that lands behind 8A's RESTRICTIVE `sensitive_gate` (the employee's national id, date of birth, bank
    account and three scheme reference numbers). `import_batch` is behind tenant RLS alone, and a sha256 over a row
    whose other columns are known is brute-forced in seconds when the unknown is a twelve-digit national id or a
    date of birth — a side channel past the gate (acceptance test 32). So `runLoad` writes `source_hash` over the
    declared columns with each non-NULL sensitive value replaced by a fixed marker, and keeps a second, full digest
    in memory only for decision 8's in-run duplicate check. **The cost:** a source that changes only a sensitive
    value after its row was recorded is not detected by a re-run (it reads as identical); a NULL that becomes a
    value, or the reverse, still is. After cut-over HR maintains those fields in Dulja, through the sensitive
    screen. Pay figures (the YTD opening's gross and net) are hashed in clear: `employee_ytd_opening` carries them
    under tenant RLS already, so the digest discloses nothing a direct read of that table does not. _(These two
    sentences are withdrawn by decision 25: the pay figures are `sensitive` too.)_
14. **A row whose `map` needs a cross-table check may read the run's own source.** `map` may read through
    `loadSource()` (never a second connection), and `cutOverDate()` gives it the run's date as `baseCurrency()`
    gives the currency. Task 8's YTD reconciliation is the case: a figure that does not reconcile must be a `map`
    skip — reported and not recorded, so the corrected source loads it — because a skip reported from `load` is
    recorded with its row and never retried (decision 7).

## Amendment — 9B Task 9 (2026-11-13), Proposed

The job, the bulk endpoint and spec:2206's status resource. Decisions 15 and 18–20 are security decisions (who may
start, read and poll a load) and decision 16 a data-model one; all are implementation authorization under the owner's
direction of 2026-11-13, not acceptance (`docs/review/2026-11-13-phase-9-decisions.md`; contracts round 20 C17).

15. **Starting a load is `admin.company.manage` at company scope** (§3.6.2's company-configuration code; §3.6.1's
    vocabulary is closed and 9B adds no code). `POST /v1/companies/{companyId}/imports` writes an `app.import_run` row
    and enqueues `admin.import.run` in one transaction (idempotent on `Idempotency-Key`, ADR 0020); a branch-narrowed
    holder is refused, as for the export (test 36). The load itself runs as the tenant's system principal (spec:2179).
16. **A run is a row, `app.import_run` (migration 0103), not only a pg-boss job.** It carries what the job needs and
    what the operator reads: who asked, the cut-over date, `dryRun`, `only`, the owner's **account map** (configuration,
    under RLS — never in the pg-boss payload, which has none), the status, the per-loader counts and the failure. At
    most one queued or running run per company, by a partial unique index — not the plan's pg-boss singleton key,
    whose 24-hour slot a finished job still holds (a dry run would have refused the real run after it). The row is
    claimed under 7A/7C's lease (four hours, two claims): a worker that dies is taken over and the load resumes
    (decision 2 makes a re-run a resume); a run claimed twice and never finished is failed.
17. **The run fails, not the job.** A refusal — `LoadError`, `PostingError`, `ImportBatchError` or the handler's own
    (a missing or malformed account map, a payload that disagrees with the row) — is recorded on the row as
    `CODE: detail` with the stable code first, and the job completes: a pg-boss retry would find the row no longer
    queued and do nothing (7C's rule). The account map is validated with `assertAccountMap` and the HR ring set before
    the legacy source is opened, and both are cleared after every run, so no run inherits another's.
18. **`GET …/imports` and `GET …/imports/{runId}` answer any holder of the gate in the company** (7A's report-run rule,
    not 7C's requester rule). A run's record holds counts, codes and legacy keys — company configuration — and
    nothing another permission gates (9B T8: no pay figure and no sensitive value in any message); the account map is
    not echoed. A run of another company or tenant is the path company's 404.
19. **`/v1/jobs/{jobId}` answers only a job with a registered subject, to its requester.** The route is membership
    only (no code names "read a job", and a job id carries no company), so the per-job rule is the row's: the envelope's
    `tenantId` must be the caller's, the job's name must have a subject (today `admin.import.run`; a report run and an
    export keep their own resources, ADR 0067), the run must be visible under RLS, of the payload's company, **requested
    by the caller**, who must **still hold** `admin.company.manage` there. Every other case — an unknown id, another
    tenant's, another requester's, a job with a resource of its own, a revoked requester — is one 404 with the same
    words, so the route never confirms that an id exists.
20. **The job status never shows pg-boss's raw `output`.** On a failure pg-boss stores the thrown error with its stack;
    the response's `output` is the subject — `{ resourceUrl, status, error }` from the run row — and `state` is
    pg-boss's. A `completed` job whose run `failed` is therefore normal (decision 17); the operator reads
    `output.status`, and `output.resourceUrl` names the run's own record.

### Questions for the owner (Task 9)

3. Decision 18 lets every holder of `admin.company.manage` in the company read every import run of it, while
   `/v1/jobs` answers only the requester (decision 19). Should the run list be requester-only too, as 7C's exports are?
4. Decision 17 completes the job on a refused run, so `state: completed` with `output.status: failed` is the normal
   shape of a refusal on the status resource. Should `/v1/jobs` instead report the subject's failure as `state: failed`?
5. The skip register (`skips.csv`) and the other artefacts are written to the worker's local disk under
   `artefacts/legacy/<runId>/`, which a container does not keep and no route serves; the run row carries their counts
   only. Should an API-started run store its skip register (an object-store artefact or rows), or is the CLI the
   rehearsal path and the API the final load's?

## Amendment — 9B review, findings 1, 4, 5 and 7 (2026-11-14), Proposed

An independent review of Phase 9 found four defects in decisions 15–17's job and route. Decisions 21 and 22 are
security decisions (whose legacy database a run may read; what a requester must hold), 23 and 24 operational ones;
all are implementation authorization under the owner's direction of 2026-11-13, not acceptance
(`docs/review/2026-11-13-phase-9-decisions.md`; contracts round 20 C19–C22).

21. **The configured legacy source is bound to one tenant and company** (finding 1). `LEGACY_ODBC_DSN` is process-wide
    in a worker that serves every tenant, so without a binding any holder of the import gate in any company loaded
    that one database — employees' sensitive fields included — into their own. `LEGACY_IMPORT_TARGET=<tenantId>:
    <companyId>` travels beside the DSN, to the worker alone. The handler refuses every other run, and every run while
    the binding is unset, with `ERR_IMPORT_SOURCE_NOT_BOUND` before the source is opened; `loadSourceFromEnv` asks
    again before it connects. The refusal never names the bound tenant or company. **The API does not refuse up
    front**: the binding would have to be threaded into the API container and its route dependencies for a check the
    worker already makes before any read, and a refused run is recorded and legible on the status resource. **The
    CLI** asks the binding of `load` and `reconcile-cut-over` whenever the DSN comes from the environment — so a
    mistyped `--company-id` cannot load one customer's books into another's — and not when an explicit `--dsn` or
    `--fixture` names the source on the same command line as the target.
22. **Starting a load asks the requester for every executed loader's write code** (finding 4) — a **tightening** of
    decision 15's gate. The load runs as the system principal, so `admin.company.manage` alone posted an
    `OPENING_BALANCE` (`accounting.journal.post`), an `OPENING_STOCK` (`inventory.receipt.post`), sealed employee
    fields and YTD openings, and chose the cut-over date and the account map. On 7A's precedent (the writer of a report
    definition must hold its permission, `assertDatasetGate`), `IMPORT_LOADER_WRITE_CODES` names each loader's codes —
    the gate of the route or policy that writes the same rows; the YTD opening, which no route writes, takes
    `hr.payroll.post`, the code whose posting writes the projection it is added to. `POST …/imports` keeps
    `admin.company.manage` as the route gate and refuses a requester lacking any code of a loader the run executes, at
    company scope, `only` respected; the job asks the same of `requested_by` when it claims the run, so a role revoked
    in between is caught before the source is opened. The trial-balance opening and the open items also refuse a
    company that holds a posted or reversed document the load did not create (opening stock already refused stock
    another document moved); an identical re-run never reaches the check, because `runLoad` hands `load` only new rows.
23. **A running load renews its claim** (finding 5). At four hours pg-boss expired a still-running job; the redelivery
    reclaimed the lapsed claim, the second load met the first's keys and failed the run, and the first's completion
    was fenced out — a load that finished read `failed`. The worker now renews its claim before every page
    (`renewLeased`, at most every five minutes, the row locked against a concurrent reclaim), so a redelivery finds it
    live and defers past it. A claim that genuinely lapsed (one page longer than the lease, or a worker that died) is
    still taken over, and the superseded worker stops before its next page and records nothing. `expireInSeconds`
    stays the lease, so a dead worker is still redelivered after four hours.
24. **No run stays queued for ever** (finding 7). A delivery that finds a load already running in its process
    schedules a follow-up job instead of throwing and spending a retry. And `POST …/imports` supersedes a run that
    stayed `queued` with no claim for longer than the lease — its job was lost, exhausted or archived — failing it with
    a stable reason as the requester, so the one-live-run index cannot block a company for ever. A cancel verb was
    the alternative; the supersede needs no route and covers the stuck case, which is the only one with no way out.

### Questions for the owner (9B review)

6. Decision 21 refuses at the worker only. Should the API also be given `LEGACY_IMPORT_TARGET` so that `POST …/imports`
   answers 403 at once for an unbound company, at the cost of a second holder of the binding?
7. Decision 22 maps the YTD opening to `hr.payroll.post` and the employee master's sealed fields to
   `hr.compensation.manage` plus `hr.employee.read_sensitive` (the sensitive route's two layers). Are those the codes
   the owner would ask of the person who loads them?

## Amendment — 9B review, findings 3 and 6 (2026-11-14), Proposed

The same review's findings 3 and 6. Decision 25 is a security decision (what `import_batch` may hold), decisions 26
and 27 data-model and money-semantics ones (when an opening may be loaded, and what a reported position becomes); all
are implementation authorization under the owner's direction of 2026-11-13, not acceptance
(`docs/review/2026-11-13-phase-9-decisions.md`).

25. **The YTD opening's pay figures enter the persisted hash as presence only** (finding 6) — decision 13's last two
    sentences are withdrawn. Decision 13 hashed `EMPYTDGROSS`/`EMPYTDNET` in clear because `employee_ytd_opening`
    carries them under tenant RLS already. That is true of the table and beside the point: the figures are read only
    through `hr.payroll.read` (its routes, its dataset and its tenant-export row), while `import_batch` is plumbing
    every loader's resolver reads, gated by nothing, and a sha256 of `{EMPID, gross, net}` is brute-forced from a
    salary range in seconds. Both columns are now `sensitive`, so the persisted digest carries each as a fixed marker
    when it holds a value. **Rejected:** a keyed digest (HMAC under the HR field key) — every key rotation would turn
    every recorded YTD row into a conflict on the next re-run, and the importer would need the key even to compare.
    **The cost** is decision 13's: a legacy YTD figure that changes after its opening was recorded is not detected by a
    re-run. After cut-over the figure is Dulja's (corrected by a supplementary run, ADR 0076), and the reconciliation
    compares what Dulja holds with the payslips, not with the legacy YTD column. No other column a loader hashes is a
    pay figure: the employee master's names and dates are stored in clear in `party` and `employee`, and `PAYITEMS` is
    read by the reconciliation only, never hashed.
26. **The two whole-table openings are one-shot** (finding 3). Decision 6 makes the trial-balance opening and opening
    stock functions of the whole table, but `runLoad` hands `load` only the rows no earlier run recorded and
    `import_batch` admits neither UPDATE nor DELETE (0102). The refusals therefore said "reverse the opening and load
    again", which could not work: after a reversal every earlier key is still recorded, so a source that gained one
    `ACCTOTALS` key posted an `OPENING_BALANCE` of that account alone with a `3900` residue of its own (and opening
    stock replayed a fragment of the history), while a source with no new key never reloaded at all. Now
    `refusePriorOpening` refuses whenever ANY earlier run recorded a row of the loader — its opening posted, reversed
    or netted to nothing (`EMPTY_TARGET`) — naming the earlier run and document. A correction after the opening is an
    ordinary Dulja document: a JOURNAL for a balance, a STOCK_COUNT for a position. A whole re-import goes into a fresh
    company, which is why the runbook now rehearses in a rehearsal company and loads the cut-over company once.
    Opening stock's movement guard is simplified to match: any stock movement in the company refuses (after the
    one-shot refusal none can be this loader's, and a reversal leaves its movements in place). Every "reverse" remedy
    is gone, `refuseForeignPostings`' and `runLoad`'s changed-row conflict included: a reversed document stands beside
    its reversal and a recorded key is never loaded again. **Rejected:** truly retrying a whole-table loader (re-reading
    every recorded row to recompute the whole opening and post only its difference) — it would need the earlier
    opening's figures to be trusted as the base of a delta, re-derive a moving average across a posted document, and
    make "reverse" mean two different things.
27. **A skip a whole-table loader's `load` reports is final** (finding 3). Opening stock records every `BILLITEMS` row,
    a reported position's included (against its warehouse's document or `EMPTY_TARGET`), so a reported position was
    never retried — contradicting `runLoad`'s "a reported row is retried", which is true only of a `map` skip of a
    paged loader. Retrying one position later would be exactly the partial replay decision 26 forbids, so the rule is
    now stated everywhere it is relied on (`runLoad`, `Loader.map`, `LoadResult.skips`, the runbook): a `map` skip is
    retried; a skip `load` reports is recorded and final; a row that maps late into a posted whole-table opening is
    refused. The cut-over corrects a reported position after cut-over with a STOCK_COUNT, and `reconcileCutOver`
    names it as explained by the skip register (ADR 0086 decision 9) — so a final skip neither fails the sign-off
    nor disappears from it.

### Questions for the owner (9B review, findings 3 and 6)

8. Decision 26 makes the openings one-shot and sends a full re-import to a fresh company. Is a rehearsal company (or
   a staging tenant) per rehearsal acceptable, or does the owner want a supported "discard this company's cut-over"
   operation instead — which would have to delete posted ledger rows and is therefore not built?

## Amendment — 2026-11-15 full review, HRP-04, HRP-13 and HRP-21 (2026-11-16), Proposed

Findings of the 2026-11-15 full review (`docs/review/2026-11-15-full-review.md`). Decisions 28 and 29 are
data-model and money-semantics decisions (what a load may record, and what it may adopt); decisions 26 and 27 stand
unchanged — this amendment closes the path by which they turned an operator's ordering mistake into a permanent empty
opening.

28. **A real run may not leave out a parent that was never loaded** (HRP-04). `selectLoaders` orders `only`'s loaders
    and ignores a dependency outside it, so `only: ["opening_stock"]` on a fresh company recorded every `BILLITEMS`
    row against no document (decision 27: a reported position is final), the later full run skipped them all (same
    hash), and the company's opening stock was permanently empty — the remedy a fresh company. Now `runLoad`, after
    pre-flight and before any loader runs, refuses (`ERR_VALIDATION_FAILED`; the CLI's exit 2, the job's `failed`) a
    run that is not a dry run when a selected loader depends on a loader left out of it which has recorded no
    `import_batch` row in the company although its source table has rows. A parent whose source table is empty
    records nothing and is not missing (a source without batches); a dry run writes nothing and is not refused (its
    counts stay an upper bound, decision 5). The rule applies to every loader, not only the two openings: a paged
    loader's `load` skips are final too. **Rejected:** loading a missing parent implicitly (the operator chose `only`
    for a reason — the runbook's `--only account` — and a silently widened run surprises), and recording nothing
    for a reported position (it would reopen decision 26's partial replay). A parent loaded only in part — some of
    its keys recorded, a later page refused — is not detected here; ADR 0086 decision 10 keeps such a position out of
    "explained".
29. **Adoption requires the same thing, not only the same code** (HRP-13). `placeByCode`'s rule 2 adopted a row a
    person made whenever its code matched; an item made in PIECE whose legacy unit is BOX then took every opening box
    as a piece, and the value-only reconciliation stayed green. A `Placement` may now name a `mismatch`, checked before
    rule 2 adopts: an item's base unit, kind and lot tracking, and a warehouse's kind and head-office branch. A
    mismatch refuses the run (`ERR_VALIDATION_FAILED`), naming the field and both values; the operator corrects or
    renames the hand-made row. **Rejected:** creating a suffixed twin (two Dulja items for one legacy material, the
    person's stock in one and the opening in the other) and reporting the row (an item skip orphans its stock).
30. **The account loader reads no amount** (HRP-21). It read `ACCOPENBAL` only to skip — and so never link — an
    account whose stored balance was NULL, though no figure is taken from that column; the account's real AccTotals
    balance then went to `3900` in a one-shot opening. The column is no longer declared. LEGACY-007 stays guarded where an
    amount is read: the trial-balance opening refuses a NULL `ACTDEBIT`/`ACTCREDIT` at its row (`moneyOf`), and 9A's
    `null_poison` report lists every NULL legacy amount before any load.
