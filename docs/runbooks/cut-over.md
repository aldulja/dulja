# Runbook — Sahlisoft → Dulja cut-over (Phase 9B)

Audience: the operator running the migration, with the customer's accountant in the room.
Prerequisites: Phases 0–8 deployed; 9A's extraction done (`docs/runbooks/legacy-extraction.md`); ADRs 0081–0086 read
— all **Proposed**. Plan 9B Task 10.

Every command below is exact. Where a step needs something only the owner can supply, the step says so and gives the
local equivalent that lets a rehearsal proceed without it: `--fixture cut-over` in place of the live source, which is
the committed synthetic corpus the test suite loads.

## 0. Before the day

- [ ] **Owner provides:** read access to the live Sahlisoft database and its Firebird version (OD-17). Prepare the
      machine as 9A's runbook says — `bun install`, then `bun pm trust odbc` once to build the native binding.
- [ ] **Never put the DSN on a command line**: `bun run` echoes its command before running it, so a password in
      `--dsn` lands in the terminal and any log. Set it in the environment and leave `--dsn` off every command below:

      ```powershell
      $env:LEGACY_ODBC_DSN = 'DRIVER={Firebird/InterBase(r) driver};DBNAME=<host>:<path>\STANDARD.FDB;UID=<user>;PWD=<password>'
      $env:LEGACY_IMPORT_TARGET = '<tenant_id>:<company_id>'
      ```

      `LEGACY_IMPORT_TARGET` binds that source to the **one** company it is loaded into (9B review, finding 1;
      contracts §3.11, round 20 C19): `load` and `reconcile-cut-over` refuse (exit 2, `ERR_IMPORT_SOURCE_NOT_BOUND`)
      any other `--tenant-id`/`--company-id` while the DSN comes from the environment, so a mistyped id cannot load one
      customer's books into another's. `scope`, `profile` and 9A's other reports write nothing to Dulja and do not ask.

      **Verify:** `bun run legacy scope --out artefacts/legacy/scope` prints an engine version and a table count.
      **Until provided:** add `--fixture cut-over` to every `bun run legacy …` command below.
- [ ] **Owner provides:** the cut-over date and the agreed treatment of account `3900` (OD-25). The date is entered,
      never derived (spec:2039). **Until provided:** a rehearsal uses the last day of an open period (the corpus is
      written for `2026-01-31`) and the residue simply stands on `3900` (`docs/owner/od-25-suspense-and-cut-over-date.md`).
- [ ] **Owner provides:** the account map — one row per legacy account, each with a Dulja code and a `treatment`
      (`balance`, `ar_control`, `ap_control`, `inventory_control`, `exclude`), in the shape of
      `packages/importer/test/fixtures/account-map.json`. Exactly one `ar_control` and one `ap_control` code; no legacy
      account on `3900`. The same file is passed to the load and to the reconciliation.
- [ ] Read 9A's reports for this database — `scope`, `profile`, all six `reconcile` kinds, `questions` — and have the
      customer accept each quantified difference. **This is the conversation, not a formality:** the
      `unbalanced_vouchers` and `aggregate_drift` totals are what ADR 0086 matches the legacy trial balance's
      imbalance against (step 5).
- [ ] **Print the legacy AR and AP ageing as at the freeze** and file it with the sign-off sheet. Dulja ages every
      imported open item from the cut-over date (ADR 0085), so on day one every item is `current`; the legacy ageing is
      the only record of how old each item really is.

## 1. Freeze

- [ ] Stop every Sahlisoft client. Confirm no session remains.
- [ ] Take a backup of the legacy database and record its checksum. **Nothing below writes to it**, but the
      reconciliation compares against exactly this state: a later write shows as unexplained rows and invalidates the
      sign-off.
- [ ] Note the freeze time. Any business transacted after it belongs in Dulja, not in the import.

## 2. Prepare the Dulja tenant

- [ ] `bun run --cwd packages/db db:migrate` — every migration through `0103`.
- [ ] Re-seed, each sub-pack on its own, with `APP_ENV=<staging|production>` on every command:
  - `APP_ENV=<staging|production> bun run seed --tenant <tenant_id> --only roles`
  - `APP_ENV=<staging|production> bun run seed --tenant <tenant_id> --only dimensions`
  - `APP_ENV=<staging|production> bun run seed --tenant <tenant_id> --only fiscal-periods`
  - `APP_ENV=<staging|production> bun run seed --tenant <tenant_id> --only chart-of-accounts` — applies `9b-cut-over.json`, creating `3900`
  - `APP_ENV=<staging|production> bun run seed --tenant <tenant_id> --only document-types` — applies `OPENING_BALANCE.json` and `OPENING_STOCK.json`
  - `APP_ENV=<staging|production> bun run seed --tenant <tenant_id> --only reports`
  - `DATABASE_URL=… bun run --cwd packages/db seed:payroll-accounts --tenant <tenant_id> --company <company_id>`
- [ ] Confirm the fiscal period containing the cut-over date is **open**: a closed one refuses the load with
      `ERR_PERIOD_NOT_OPEN`, by design (acceptance test 9).
- [ ] Bind `HR_FIELD_ENCRYPTION_KEY` (and `HR_FIELD_ENCRYPTION_KEY_VERSION`, default `1`) — the **same** key the
      tenant's api and worker run with (`docs/runbooks/deploy.md`): the employee load seals national ids, bank
      accounts and statutory numbers under it, and the CLI refuses (exit 2) to load employees without it. There is no
      development fallback.
- [ ] For an API load only: bind `LEGACY_ODBC_DSN` **and** `LEGACY_IMPORT_TARGET=<tenant_id>:<company_id>` on the
      **worker** (`docs/runbooks/deploy.md`, "Secrets"); the api receives neither. The worker serves every tenant and
      the DSN is process-wide, so the binding is what keeps any other company's import run from reading this
      database: each one fails `ERR_IMPORT_SOURCE_NOT_BOUND` before the source is opened, and so does every run while
      the binding is unset.

## 3. Rehearse (CLI)

The rehearsal is the CLI's: an API run's artefacts (`preflight.json`, `skips.csv`, `load-summary.json`) stay on the
worker's local disk and no route serves them (ADR 0084 owner question 5).

- [ ] **Rehearse in a rehearsal company, never in the company you cut over.** The trial-balance opening and opening
      stock are **one-shot** (9B review, finding 3; ADR 0084 decision 26): once a run has recorded either, no later run
      loads it again — not after the source is corrected, not after the opening is **reversed**. A reversal corrects
      the books; it does not un-record the rows, so a re-run would compute the opening from the late rows alone, and
      the load refuses that (`ERR_IMPORT_DUPLICATE_SOURCE_KEY`, "the importer's opening is one-shot"). So rehearse —
      dry runs and real runs alike — in a company created for it (a second company of the tenant, or a staging
      tenant), point `LEGACY_IMPORT_TARGET` at it while you do, and start again in a **fresh** rehearsal company
      whenever the source or the map changes. Step 4's real load goes into the cut-over company once, against the
      frozen source the last clean rehearsal read.

- [ ] **Link the chart first:** `bun run legacy load --tenant-id <id> --company-id <id> --cut-over-date <YYYY-MM-DD>
      --account-map <path> --only account`. This is a real run, and it writes no money — it only records which
      Dulja account each legacy code is. A dry run resolves accounts only through links an earlier real run
      recorded (it writes no `import_batch` row), so without this step every `balance` account reads "never linked".
- [ ] **OD-27, Part VII #13 — is the legacy Salaries module live?** Read 9A's `questions.json` (`part7-13`). If the
      answer is *no*, run every `load` below with `--only` leaving out `employee,employee_ytd_opening`: there is no
      employee master to bring and no YTD to reconcile. If *yes* or *unanswered*, run the full load; an empty
      `EMPLOYEES` simply loads zero employees and no `employee_ytd_opening`. A source with **no** `EMPLOYEES` table fails
      pre-flight and the message names this same `--only` remedy (`docs/decisions/od-27-9b-part-vii-7-and-13.md`).
- [ ] **OD-27, Part VII #7 — does `MatOpens.Job` ever differ from 0?** Read `part7-7` too. The real load asks it
      itself and **refuses** opening stock if any job is non-zero (SAH-022) — a dry run does not reach that check. A
      refusal is not a bug: the legacy opening stock was partitioned by project and someone must decide how a job maps
      to a Dulja warehouse first.
- [ ] `bun run legacy load --tenant-id <id> --company-id <id> --cut-over-date <YYYY-MM-DD> --account-map <path>
      --dry-run`
- [ ] Read `artefacts/legacy/<runId>/preflight.json`. **Every required column must be present.** A missing one means
      the column map is wrong for this customer's database — fix `sourceColumns`, do not widen the map to make the
      failure go away. Promoting a confirmed column from `hypothesis` to `verified` follows
      `docs/owner/od-17-live-database.md` (OD-17) and nothing else.
- [ ] Read `artefacts/legacy/<runId>/skips.csv` with the accountant. Every line is a row the import will not load and
      why. A skip of a paged loader (a party, an item, an open item, a withheld YTD) is retried by the next run once the
      source or the map is corrected; **a position opening stock reports, and anything the trial-balance opening
      skipped once it has posted, is final** — corrected after cut-over by an ordinary document (step 5). In a dry run, open items and opening stock also read their parties and items as "never linked" — those
      lines are the dry run's, not the source's. Decide, per remaining line, whether it is acceptable or whether the
      source needs correcting. A withheld YTD opening is keyed `YTD:<EMPID>` and never shows the figure.
- [ ] Read `artefacts/legacy/<runId>/load-summary.json` for the shape of the run, **not** for exact totals: a dry
      run's `inserted` counts rows that mapped, an upper bound on the real run's (ADR 0084 decision 5). `skipped` and
      the pre-flight findings are exact.

## 4. Load

Either path runs the same `runLoad` as the tenant's system principal. Only one run per company may be queued or
running; a run that stays **queued** for more than four hours without a worker ever claiming it (its job was lost) is
superseded — failed, with that reason — by the next request (9B review, finding 7). A long load keeps its claim while
it makes progress (the worker renews it before every page), so a load of more than four hours is not taken over.

- [ ] **CLI:** the step 3 command without `--dry-run`. Exit 0 is a clean load; exit 1 a load that reported skips
      (read `skips.csv`); 2 a configuration mistake or a refusal (the message starts with its `ERR_` code); 3 an
      unreadable source or a failed pre-flight.
- [ ] **API:** `POST /v1/companies/{companyId}/imports` (gate `admin.company.manage`, an `Idempotency-Key`; the
      requester must **also** hold, company-wide, the write code of every loader the run executes —
      `IMPORT_LOADER_WRITE_CODES`: `inventory.item.manage`, `accounting.account.manage`, `accounting.party.manage`,
      `hr.employee.manage`, `hr.compensation.manage`, `hr.employee.read_sensitive`, `accounting.journal.post`,
      `hr.payroll.post` and `inventory.receipt.post` for a full run, fewer with `only`; a missing one is 403
      `ERR_RBAC_FORBIDDEN` naming it, and the worker asks again when it starts the run) with
      `{ "cutOverDate": "<YYYY-MM-DD>", "dryRun": false, "accountMap": { … } }` — the map is required whenever the run
      includes `account`, `opening_balance` or `open_item`. The answer is 202 `{ runId, jobId, statusUrl }`. Poll
      `GET /v1/jobs/{jobId}` until `state` is `completed`, then read **`output.status`**: `done`, or `failed` with
      `output.error` (a refused run still completes as a job). `GET /v1/companies/{companyId}/imports/{runId}` is the
      run's record.
- [ ] If it fails, **re-run the same command**. The load is idempotent on `(source_table, source_key)`; committed
      pages are not repeated, and `--only` resumes from a named loader. Do not delete anything. A real run whose
      `--only` leaves out a loader it depends on (`opening_stock` without `item`, `warehouse` or `lot`;
      `opening_balance` without `account`) is refused (`ERR_VALIDATION_FAILED`, exit 2) while that parent has never
      been loaded and its source table has rows — the openings are one-shot, so an opening run ahead of its parents
      could never be repeated (2026-11-15 review, HRP-04).
- [ ] Write every option as `--key value` (or a bare `--switch`). The CLI refuses — exit 2, before anything is opened
      — the `--key=value` form, an option the command does not read, a switch given a value (`--dry-run true`), a
      key given twice and an empty value (`--fixture ""`): `--dry-run=true` once ran a real, one-shot load
      (2026-11-15 review, HRP-05/HRP-06).
- [ ] The load adopts a Dulja item or warehouse a person already made under the same code only when it is the same
      thing: an item with another base unit, kind or lot tracking, or a warehouse outside the head office, refuses
      the run naming the field — correct or rename it before the load (HRP-13).
- [ ] The trial-balance opening and the open items load only into a company that has posted nothing else: a document
      posted outside the load (a test sale, a hand journal) refuses them (`ERR_VALIDATION_FAILED`, naming it). Load
      into a fresh company: reversing that document does not make this one fresh, because it stands, reversed, beside
      its reversal. Opening stock likewise refuses a company that holds any stock movement.
- [ ] **Never reverse an imported opening to "load it again".** It is one-shot (step 3): a re-run after a reversal
      loads nothing, and one against a grown source is refused. Correct a balance with a JOURNAL and a stock position
      with a STOCK_COUNT after cut-over; redo the whole import only in a fresh company.

## 5. Reconcile

- [ ] `bun run legacy reconcile-cut-over --tenant-id <id> --company-id <id> --cut-over-date <YYYY-MM-DD>
      --account-map <path>` — with the same map and against the same frozen source.
  - **Exit 0:** every difference is zero or explained (ADR 0086). **Exit 4:** at least one is not; each is printed as
    `unexplained: <key> — <label> — difference <x>` and listed in the JSON's `unexplained`. **Stop** and find the
    cause. A paged loader's row (a party, an item, an open item, a YTD opening) is corrected in the source or the map
    and re-run (`--only` the loader concerned); the trial-balance opening and opening stock are one-shot, so a cause
    there means the load is redone in a **fresh** company — or, once the owner accepts the rest, corrected after
    cut-over with a JOURNAL or a STOCK_COUNT — and reconciled again. Exit 2 and 3 are
    configuration and an unreadable source, as for `load`.
  - It writes `cut-over-reconciliation.json` and `.csv` under `artefacts/legacy/<runId>/` — a directory of its own —
    with their sha256 in that directory's `index.json`.
- [ ] Walk the four sections with the accountant:
  - **`trialBalance`** — per Dulja account, the legacy stored net against Dulja's ledger at the cut-over date,
    debit-positive. `balance` accounts must agree to the cent; the AR/AP controls must equal the legacy open items
    (any legacy control drift from its items is named); the inventory control must equal the recomputed valuation
    (the recost from the legacy figure is named); `exclude` accounts are named as the owner's exclusion. Compare with
    the legacy trial-balance report.
  - **`suspense`** — `3900` decomposed: the legacy trial balance's own imbalance, matched exactly by 9A's
    `unbalanced_vouchers`/`aggregate_drift` totals, and `3900` itself = Σ trial-balance differences − that imbalance,
    to the cent. This figure is what OD-25's treatment is about.
  - **`stockValuation`** — per item and warehouse, the recomputation of the legacy movement history against Dulja's
    valuation. A position the load read and **reported** rather than opened (a service, an item, warehouse or batch
    that did not import, another item's batch) is listed with its legacy value against zero and explained by the skip
    register: opening stock is one-shot, so count it with a STOCK_COUNT after cut-over (ADR 0086 decision 9). A
    position the load never read — the source grew after it — stays unexplained. A pool the legacy history drives
    negative is listed with zero on both sides and named in the skip
    register: count it after cut-over.
  - **`employeeYtd`** — per employee (`YTD:<EMPID>`), the YTD opening against the sum of their own payslips for the
    cut-over year, gross and net. The artefact carries no pay figure: compare figures in the legacy payroll, on screen.
- [ ] Print the summary and the CSV. The customer initials it. Record `cut-over-reconciliation.json`'s sha256 from
      `index.json` on the sheet; the hash makes the printed copy and the file provably the same.
- [ ] Turn to `docs/runbooks/cut-over-suspense.md` and record the agreed treatment of `3900` (OD-25). If no
      treatment has been agreed, the balance stands — that is the default and it is not a failure. A write-off or a
      reclassification is a JOURNAL posted by the accountant after the sign-off, dated the day after the cut-over
      date; the import never writes one.

## 6. Start the new series and hand over

- [ ] Confirm `app.document_series` holds rows for **`OB` and `OS` only**. Every live series — `JV`, `INV`, `PINV`,
      `PO`, `GRN`, `PAY`… — starts at 1 with the first real document after cut-over (§5.1 #8).
- [ ] **Force a password reset for every user.** Legacy passwords are cleartext (SAH-028) and are never imported;
      there is no `Users` loader. Invite each user through `POST /v1/admin/users` and have them enrol MFA.
      **Verify (OD-26):** `bun run --cwd tests test regression/sah-028` and
      `bun run --cwd packages/importer test test/load/registry` — they assert that no loader names a `USERS` source,
      that no declared source column matches `PASSWORD` or `PIN` and none is on 9A's `NEVER_READ` deny-list (which is
      unchanged), that `packages/importer/src/load` never names a password or a PIN, and that the invite body has no
      password field to migrate one into (`docs/owner/od-26-legacy-passwords.md`).
      **If the owner answers Part VII #4 with "yes, hashed with X":** nothing here changes. Dulja has no password
      column to rehash into — identity is Supabase with MFA — so a hashed legacy credential is still not importable,
      and the answer only affects whether the archived legacy database is worth keeping for a forensic reason.
- [ ] Keep the frozen legacy database **read-only and retained**: an imported open item carries only its number and
      its balance, so the original document is looked up there (ADR 0085), with the ageing printed in step 0.
- [ ] Remove the legacy credential and its binding: `wrangler secret delete LEGACY_ODBC_DSN` and
      `wrangler secret delete LEGACY_IMPORT_TARGET` on the worker if they were bound, and clear both from the
      operator's shell. The cut-over is over; the credential has no further use.
