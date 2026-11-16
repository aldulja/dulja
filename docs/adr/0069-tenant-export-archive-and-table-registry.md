# 0069 — The tenant export is one deterministic .tar.gz over an explicit table registry

- Status: **Proposed** — spec:95 requires anything touching the data model or security to be written as a
  proposal and asked before implementing, and this decides what leaves the system. The registry and the
  schema document are implemented ahead of approval (7C Task 7), as ADRs 0054–0067 were; the archive writer
  is 7C Task 8.
- Date: 2026-11-05 (the plan's text is dated 2026-09-08)
- Slice: 7C · Task 7 (decision 1 landed in Task 8)
- Amends: none. Consumed by ADR 0070 (the request-time gate) and by 8A, which adds `employee_sensitive`.

## Context

spec:2186 requires data export at any time, unprompted, "in open formats (CSV + JSON + a documented
schema)"; spec:2211 makes it the right-to-export workflow; spec:1067 includes attachments; spec:2206
requires async job semantics with a status resource. §4.6.1 gives `export_job` a **single** `object_key`
and a **single** `sha256` (migration 0078), so one export is one artefact.

Two questions follow. What container holds CSV + JSON + a schema + attachment bytes? And what decides which
rows and columns go in — given that the job runs as the tenant's system principal (spec:2179), which holds
every permission and which RLS bounds to the tenant and nothing narrower?

## Decision

**1. One `.tar.gz`, written by a small deterministic USTAR writer plus `node:zlib`** (Task 8). Layout:

    schema.json
    manifest.json
    tables/<table>.csv        (format 'csv' | 'both')
    tables/<table>.json       (format 'json' | 'both')
    attachments/<attachment_id>-<file_name>

Every header field a tar carries that could vary — mtime, uid, gid, uname, gname, mode — is written as a
fixed value, entries are emitted in registry order (`schema.json` first, `manifest.json` last), every table
query has a total `order by`, and the gzip header carries no mtime, no name and the "unknown" OS byte. So
**`runExport` is a function of the included rows, the job row, `generatedAt` and the attachment bytes: the
same inputs give a byte-identical archive and therefore an identical `sha256`** (Task 8's tests assert it).
That is what lets a tenant verify an export, and what lets a test assert determinism rather than "it ran".
What the claim does *not* say, stated so nobody relies on it (Task 8):

- **Two different export jobs never produce the same archive**: `manifest.json` names its own job and
  `generatedAt` (the job's claim time, `export_job.started_at`). Their `tables/` files are identical when
  the books did not change in between — except `tables/audit_log.*` for a requester holding
  `admin.audit_log.read`, because every export's own status writes are audited (test 13) and the later
  archive carries them. That is the audit trail growing, not noise, and Task 8's test proves the difference
  is exactly those rows.
- **The deflate stream is zlib's.** The same tar is compressed to the same bytes by the same zlib build; a
  different build may choose a different (equally valid) stream. The tar inside, and each file in it, is
  deterministic regardless.
- `tables/<table>.json` is newline-delimited JSON — one object per row, keys in column order — and
  `schema.json` says so (`tableJson`).
- `tables/<table>.csv` is written raw, with no BOM and no spreadsheet formula neutralisation (unlike a report
  CSV, whose `renderCsv` prefixes `'` to a cell that starts with `= + - @`, TAB or CR — 7 review): it is a
  machine-readable data export whose bytes must equal the stored values, so its consumer must import it as
  data (a typed import or a parser), never open it as a spreadsheet that evaluates formulas.

**2. An explicit registry, `EXPORT_TABLES` (`packages/db/src/export/tables.ts`), with per-table permission
gates.** Each entry names its table, its columns **in full and in order**, a gate (`null` = included for
anyone who holds `admin.data.export`) and a scope. The job resolves every gate once, for the **requesting**
principal, through `app.principal_has` with a null branch, and includes a table only when the gate is held;
an excluded table is **named** in `manifest.excluded` with its gate. A gate is the read authority that
already guards the same rows elsewhere:

| Gate | Tables | Why |
|---|---|---|
| — | the books and master data: company, accounts, periods, dimensions, document types and policies, custom fields, parties, items, units, warehouses, lots, prices, promotions, documents, lines, links, series, voids, the ledger and its dimensions, balances, allocations, ageing, bank statements and matches, stock on hand, terminals and branch POS policy, report definitions, saved views, attachment metadata, the members and their roles | spec:2186 "it is your own books"; `admin.data.export` is that authority |
| `inventory.cost.read` | `inventory_movement`, `cost_layer`, `cost_consumption`, `stock_valuation`, `landed_cost_allocation`, `item_profitability` | 3B made cost a separate read; the movement ledger carries each movement's `value` |
| `accounting.tax.manage` | `tax_regime`, `tax_code`, `tax_transaction`, `tax_return` | 5A's tax reads and 7C's `accounting.tax_return_view` |
| `accounting.tax.file` | `einvoice_transmission` | 5B's transmission routes |
| `hr.employee.read` | `employee`, `attendance_event`, `pos_cashier` | 6C's staff reads |
| `pos.report.read` | `shift`, `till_event`, `till_banking_link` | 6D's shift and Z-report reads |
| `pos.needs_attention.resolve` | `needs_attention` | 6A's quarantine list and 7C's `pos.needs_attention` |
| `admin.audit_log.read` | `audit_log`, `document_event`, `report_run` | 0B's audit read and 7B's `accounting.document_event_log`; `report_run` — who ran which report, when, with what parameters — is activity, so audit information (second review, 2026-11-06; it was `accounting.report.export`, which handed every run to an export-code holder the runs list would refuse) |

**3. Every `app` table is classified.** A table is either registered or pinned whole in `NEVER_EXPORTED`
with its reason, never both and never neither; `packages/db/test/export/tables.test.ts` walks
`information_schema` and fails on an unclassified table, so a table a later migration adds does not leave
the system until its slice has reasoned about it. `NEVER_EXPORTED` holds two kinds of entry:

- **secrets**, whatever the registry says: `principal.auth_subject`, `pos_cashier.pin_hash`,
  `pos_terminal.device_public_key`, `company.einvoice_client_id` and `einvoice_credential_ref`,
  `needs_attention.payload` (the till's raw request body), `attachment.object_key` and
  `report_run.object_key` (SAH-038: a store key never reaches the wire), `audit_log.before`/`after`, and
  the whole of `terminal_enrolment` and `idempotency_key`;
- **plumbing** that is not a business record and would make two exports of one set of books differ:
  `terminal_request_guard`, `catalogue_tombstone`, `cost_booking`, `export_job` itself, `report_run.started_at`
  and `report_run.attempts` (the render worker's lease and fencing token), and the global
  `permission` catalogue.

`employee_sensitive` is pinned `["*"]` before 8A creates it.

**4. `audit_log.before` / `.after` are not exported.** They are row images of every table, the gated ones
included, so exporting them would defeat every gate at once. The audit *trail* — who did what, when, to
which row — is exported behind `admin.audit_log.read`; the payloads stay behind `/v1/admin/audit-log`. This
is the same reasoning 7B applied to the audit report (its amendment A3). The audit trail and the tenant-wide
reference tables (`tenant`, `currency`, `principal` through `membership`, `role`, `role_permission`) are
`scope: "tenant"`; every other query carries its own `company_id` predicate, because the job's RLS bounds
the tenant only.

**5. The documented schema is built from the database.** `exportSchemaDocument`
(`packages/db/src/export/schema.ts`) reads `information_schema` for each included table: every exported
column carries its database type, nullability and numeric scale; every live column left out is listed as
`omitted`; a registry column the database lacks, a pinned column, or a pinned table throws. Values are
wire-shaped as 7A's datasets are — fixed-decimal strings for money, quantities, rates and `bigint`s,
`YYYY-MM-DD` dates, RFC 3339 UTC timestamps to the microsecond, `jsonb` as JSON text, `bytea` as lower-case
hex — and the document says so.

## Alternatives rejected

- **A zip.** Friendlier to double-click, but Node has no built-in zip writer, so it means a dependency, and
  zip's local-header timestamps make determinism fiddlier than tar's. `.tar.gz` is an open format in the
  sense spec:2186 means, and every target platform reads it.
- **Streaming one file per table to the object store.** Fits nothing in §4.6.1: one `object_key`, one
  `sha256`, one status resource.
- **Deriving the column list from `information_schema` at run time.** Then a column added by a future
  migration leaks by default. The registry inverts that: a new column does not leave until someone adds it.
- **Leaving unregistered tables unclassified.** The plan's registry named the tables it exported and said
  nothing of the rest, so a later table was silently absent rather than deliberately absent — and nothing
  told its slice to decide. The classification test turns that silence into a failing build.
- **Re-deriving the requester's authority inside the job.** The job is the system principal and would
  resolve *its own* authority, which is everything. ADR 0070 records the request-time snapshot instead.

## Consequences

- A slice that adds a sensitive table adds one `EXPORT_TABLES` row with its gate (or a `NEVER_EXPORTED`
  pin) and changes **no exporter code**. 8A's `employee_sensitive` is the case this is built for (test 32).
- **A table pinned in `NEVER_EXPORTED` is refused until the slice that owns it narrows the pin, in the same
  PR as its registry row.** 8A therefore makes two edits — the row, and the pin narrowed to the ciphertext
  columns it will not export — and the second is the deliberate act this ADR asks for.
- A slice that adds a column to an exported table must add it to the registry deliberately, or it stays in
  `schema.json`'s `omitted` list.
- `document_line.cost` is omitted: it is the figure `inventory_movement.value` carries behind
  `inventory.cost.read`, and a line table everyone exporting the books receives must not carry it.
- A requester without a gate gets a smaller archive whose manifest says exactly what is missing; the seeded
  `auditor` (admin.data.export, inventory.cost.read, pos.report.read, admin.audit_log.read,
  accounting.report.export) receives everything except the tax, e-invoice, HR and needs-attention tables,
  which matches what that role can read through the API today.
- `audit_log` is tenant-wide, so in a multi-company tenant an export of one company carries the audit trail
  of all of them — the trail only (table, row id, action, actor, time), behind `admin.audit_log.read`, as
  7A's `audit_log` dataset already does. Whether it should be narrowed to the company's rows is an owner
  question.
- The archive's determinism is asserted by a test that runs the same job twice and compares digests, and by
  a second that exports unchanged books twice under a requester holding the audit gate and proves the only
  `tables/` difference is the earlier export's own audit row (Task 8).
- **An export is not one snapshot across tables.** The job reads inside `withTenant`, whose transaction is
  `read committed` (§4.2.2), so each table is read at its own statement's snapshot: an export taken while
  the company is posting can carry a document whose ledger rows landed a moment after `ledger_entry` was
  read. A `repeatable read` read transaction would close that, but `withTenant`'s isolation level is a
  frozen §4.2.2 contract this slice does not amend; it is raised here for the owner, and until then an
  export taken outside trading hours is the consistent one.
- The whole archive is built in memory before it is stored, so an export's size is bounded by the worker's
  memory. Streaming it would also need a streaming object-store `put`, which §4.5.8's `ObjectStore` lacks.
- **Attachments** (spec:1067): an attachment's bytes are included when the requester's recorded modules
  (or `lot_attachments`, for a lot's) cover it, and every attachment left out is named in
  `manifest.attachmentsOmitted` with one of three reasons — `module_not_readable`, `object_missing`, or
  `digest_mismatch` when the stored bytes no longer hash to the SHA-256 the row recorded, so the archive
  never ships bytes under a digest they do not have. The manifest carries no object-store key (SAH-038).
- **Amendment (Phase 7 review, 2026-11-06, Proposed).** `runExport` no longer runs inside the caller's
  transaction. It takes a read runner (`ExportReadTransaction`, the caller's `withTenant` bound to its
  principal) and opens ONE short transaction for the rows — the gates, `schema.json`, every included table
  and the attachment rows — then fetches the attachment bytes after it has committed (hazard 20,
  spec:1368). One `withTenant` around the whole build held an `app_rw` connection and its snapshot open
  across one object-store round-trip per attachment. Determinism is unchanged — the inputs are the same rows
  and the same bytes, in the same order — and an object removed or replaced between the read and the fetch is
  named by the existing `object_missing` and `digest_mismatch` reasons
  (`apps/worker/test/handlers/export-run.test.ts` proves no transaction is open during a `get`).

## Owner questions

1. Approve the gate table in decision 2 — in particular that the books are ungated under
   `admin.data.export`, and that the tax and HR tables need their own read codes, which the seeded
   `auditor` does not hold.
2. Approve the `NEVER_EXPORTED` list in decision 3, and the rule that every table is classified.
3. Should `audit_log` be narrowed to the exported company's rows (decision 4)?

## Amendment — Phase 7 second review, 2026-11-06 (Proposed)

1. **`report_run` is audit information.** It was gated on `accounting.report.export`, so an export-code
   holder received every run of the company — the parameters and requesters of runs whose definitions (the
   audit log, the cost reports) they may not read — re-opening the leak `listReportRuns` closed (ADR 0067).
   Who ran which report, when and with what parameters is an activity record: decision 2's table now gates
   `report_run` on `admin.audit_log.read`, beside `audit_log` and `document_event`. Its lease columns
   `started_at` and `attempts` are pinned in `NEVER_EXPORTED` as plumbing beside `object_key` (decision 3);
   `export_job` stays pinned whole.
2. **The export job's lease and artefact follow the report run's** (ADR 0067's second-review amendment): a
   delivery that finds a live claim schedules one follow-up after the hour's lease instead of spending a
   retry, and each claim stores its archive under its own key (`<tenant>/exports/<job>/<attempt>.tar.gz`),
   so a superseded worker never overwrites the archive whose digest the row records.

## Amendment — Phase 8 review, 2026-11-08 (Proposed)

1. **An `hr` document's rows leave only under `hr.payroll.read`.** Decision 2 exported the books ungated
   under `admin.data.export`, and Phase 8 put payroll into the books: a posted `PAYROLL`'s lines and ledger
   rows are per-employee pay (with the `EMPLOYEE` dimension beside them), and a `PAYROLL_PAYMENT`'s lines name
   each employee beside their net. So an accountant's export carried exactly what `payroll_line` and
   `employee_ytd` are gated to keep from them (test 32). The registry now gates **rows inside a table**, not
   only whole tables: `MODULE_ROW_GATES` maps a document module to its code (`hr` → `hr.payroll.read`, §4.5.8's
   read code for that module), and every table whose rows belong to documents — `document`, `document_line`,
   `document_link`, `document_event`, `ledger_entry`, `ledger_entry_dimension`, `allocation`, `bank_match`,
   `custom_field_value` and `attachment` (`MODULE_BOUNDED_TABLES`) — leaves out the rows of a hidden module's
   documents. The gate is resolved with the table gates, for the requester, at company scope
   (`resolveExportGates`), and each table so bounded is named in the manifest's new `excludedRows`
   (`{ table, gate, module }`), so the archive says what it lacks, as `excluded` does for whole tables. The
   other modules are unchanged: their documents are the books an exporter exists to take.
2. **What still leaves.** `account_balance` and `party_ageing` are aggregates and leave whole, so a period's
   total salary expense per account is in an accountant's export (as it is in their trial balance), never a
   per-employee figure. `dimension_value` keeps the `EMPLOYEE` dimension's rows (an employee number and the
   name `party` already exports); without the bounded ledger rows they carry no amount. An attachment of an `hr`
   document was already kept out by ADR 0070's recorded modules (`attachmentsOmitted`, `module_not_readable`);
   its metadata row is now kept out too.
3. **A pin keeps it closed.** `packages/db/test/export/tables.test.ts` fails on a registered table with a
   foreign key to `app.document` that is neither module-bounded, nor gated on a `MODULE_ROW_GATES` code, nor
   named as holding only non-`hr` documents — so a later table that carries payroll rows cannot leave ungated
   silently.
