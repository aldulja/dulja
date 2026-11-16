-- The till's local model. §4.10.6 = spec:1328-1335 + `outbox.kind` + `catalogue_branch_pos_policy`.
-- ADR 0057: this is a CACHE WITH AN OUTBOX, not a second model (spec:1358).
--
-- Two kinds of table and no third:
--   catalogue_*  read-only mirrors; the ONLY writer is SqliteSyncStore.applyChanges (Task 2).
--   everything else  rows the till created and owns until the server acknowledges them.
--
-- Every money column is TEXT at 4 dp, every quantity TEXT at 6 dp, every revision TEXT holding a decimal
-- integer (A8b): better-sqlite3 returns INTEGER as a JavaScript number, and a revision past 2^53 read as a
-- double re-delivers one row for ever -- the failure acceptance test 20 exists to catch. REAL would be the
-- float spec:2041 forbids "anywhere, including in TypeScript".

-- ── 1. meta and cursors ───────────────────────────────────────────────────────────────────────────────
create table if not exists meta (
  key   text primary key,
  value text not null
) strict;

-- spec:1330 "sync_cursor(stream, revision) -- one row per down-sync stream". Eight rows, one per Stream.
create table if not exists sync_cursor (
  stream   text primary key,
  revision text not null default '0'
) strict;

-- ── 2. the catalogue mirrors (spec:1328) ──────────────────────────────────────────────────────────────
-- `row_json` is the server row verbatim (`to_jsonb(row) - 'tenant_id'`, 6A's readCatalogue). The extracted
-- columns exist ONLY where a lookup needs an index; they are derived from row_json by the mirror writer and
-- are never a second source of truth.
create table if not exists catalogue_item (
  id            text primary key,
  revision      text not null,
  row_json      text not null,
  code          text not null,
  barcode       text,
  name_en       text not null,
  name_ar       text,
  kind          text not null,
  base_unit_id  text not null,
  track_lots    integer not null default 0,
  stock_hint    text,                      -- ADVISORY (spec:1307). Null unless the page carried one.
  stock_hint_at text
) strict;
create index if not exists catalogue_item_code_idx on catalogue_item (code);
create index if not exists catalogue_item_barcode_idx on catalogue_item (barcode);

create table if not exists catalogue_price_list (
  id            text primary key,
  revision      text not null,
  row_json      text not null,
  code          text not null,
  currency      text not null,
  customer_kind text,
  branch_id     text,                      -- NULL means every branch (Form B, §4.5.6)
  valid_from    text,
  valid_to      text
) strict;

create table if not exists catalogue_price_list_line (
  id            text primary key,
  revision      text not null,
  row_json      text not null,
  price_list_id text not null,
  item_id       text not null,
  unit_id       text,
  min_quantity  text not null,
  unit_price    text not null
) strict;
create index if not exists catalogue_price_list_line_lookup_idx
  on catalogue_price_list_line (item_id, price_list_id, min_quantity);

create table if not exists catalogue_promotion (
  id         text primary key,
  revision   text not null,
  row_json   text not null,
  code       text not null,
  kind       text not null,
  definition text not null,
  starts_at  text,
  ends_at    text,
  branch_id  text
) strict;

create table if not exists catalogue_customer (
  id           text primary key,
  revision     text not null,
  row_json     text not null,
  code         text not null,
  name_en      text not null,
  name_ar      text,
  phone        text,
  currency     text,
  credit_limit text,                       -- 4A's column; null when the party has no limit
  credit_hold  integer not null default 0
) strict;
create index if not exists catalogue_customer_code_idx on catalogue_customer (code);
create index if not exists catalogue_customer_phone_idx on catalogue_customer (phone);

create table if not exists catalogue_tax_code (
  id                text primary key,
  revision          text not null,
  row_json          text not null,
  code              text not null,
  rate              text not null,
  kind              text not null,
  rounding_mode     text not null,
  output_account_id text,
  input_account_id  text,
  effective_from    text,
  effective_to      text,
  -- 5A's `app.tax_code.archived_at` (spec:2049 -- master data is archived, never deleted). Extracted and not
  -- left in row_json alone because `defaultOutputTaxCode` (T5) counts the OPEN output codes and must not
  -- count a superseded one: two rows whose windows both contain today would make the count 2 and the answer
  -- `null`, taxing every line at nothing on a shop that has exactly one live code.
  archived_at       text
) strict;

-- spec:1328's `catalogue_cashier`. `pin_hash` is an Argon2id PHC string produced by 6C's hashPin on the
-- server; the till only ever calls verifyPin against it (spec:1324 -- the PIN is never a login).
create table if not exists catalogue_cashier (
  id             text primary key,          -- the cashier's PRINCIPAL id (app.pos_cashier's PK, §4.6.3)
  revision       text not null,
  row_json       text not null,
  employee_id    text not null,
  branch_id      text not null,
  pin_hash       text not null,
  snapshot_json  text not null,             -- { codes: [...], limits: {...}, revision: "..." } (§4.6.3)
  revoked_at     text
) strict;

-- §4.10.6's addition to spec:1328. One row per branch; a till holds exactly its own (spec:1312).
create table if not exists catalogue_branch_pos_policy (
  id                       text primary key,
  revision                 text not null,
  row_json                 text not null,
  branch_id                text not null,
  max_line_discount_pct    text not null,
  max_ticket_discount_pct  text not null,
  max_void_amount          text not null,
  max_price_override_pct   text not null,
  blind_return_allowed     integer not null default 0,
  max_blind_return_amount  text not null,
  max_cash_in_drawer       text,
  require_customer_over    text,
  rounding_increment       text not null,
  paid_out_allowed         integer not null default 0,
  max_paid_out_amount      text not null
) strict;

-- ── 3. what the till itself created (spec:1331-1336) ──────────────────────────────────────────────────
-- spec:1331's column list, with the §3.3 naming rule applied: the cashier is ATTRIBUTION data, so
-- `cashier_principal_id`, never `opened_by` (§4.6.5 states the same for the server's app.shift).
-- Expected cash and over/short are computed exclusively by the server (A8c).
create table if not exists shift (
  id                   text primary key,    -- uuidv7 minted at the till = app.shift.id (§4.6.5)
  terminal_id          text not null,
  cashier_principal_id text not null,
  opened_at            text not null,
  opening_float        text not null,
  currency             text not null,
  closed_at            text,
  counted_cash         text
) strict;

create table if not exists ticket (
  id                   text primary key,    -- the uuidv7 minted at the moment of sale = document.client_ref
  shift_id             text not null references shift (id),
  cashier_principal_id text not null,
  customer_id          text,
  kind                 text not null check (kind in ('sale', 'return')),
  returns_client_ref   text,                -- the original ticket; NULL on a BLIND return
  status               text not null check (status in ('open', 'completed', 'voided')),
  currency             text not null,
  net_total            text not null,       -- Sum of line amounts, excl. tax
  tax_total            text not null,
  total                text not null,       -- net_total + tax_total = what the customer pays
  catalogue_revision   text not null,
  created_at           text not null,
  events_json          text not null default '[]'
) strict;
create index if not exists ticket_shift_idx on ticket (shift_id);
create index if not exists ticket_created_idx on ticket (created_at);

create table if not exists ticket_line (
  ticket_id   text not null references ticket (id) on delete cascade,
  line_no     integer not null,
  item_id     text not null,
  lot_id      text,
  quantity    text not null,                -- NEGATIVE on a return line (§4.4.2 A9's 6A entry)
  unit_id     text not null,
  unit_price  text not null,
  discount    text not null,
  tax_code_id text,
  tax_amount  text not null,
  total       text not null,                -- the tax-INCLUSIVE line total
  primary key (ticket_id, line_no)
) strict;

create table if not exists ticket_tender (
  ticket_id text not null references ticket (id) on delete cascade,
  tender_no integer not null,
  method    text not null check (method in ('cash', 'card', 'transfer', 'store_credit')),
  amount    text not null,
  reference text,
  primary key (ticket_id, tender_no)
) strict;

-- spec:1354's event stream. 6D owns app.till_event; the till records them from day one and the outbox
-- carries them, which is what makes 6D's arrival a server-side change only.
create table if not exists till_event (
  id                      text primary key,   -- uuidv7 = till_event.client_ref
  shift_id                text not null references shift (id),
  kind                    text not null check (kind in ('no_sale', 'drawer_open', 'void')),
  ticket_client_ref       text,
  cashier_principal_id    text not null,
  supervisor_principal_id text,
  occurred_at             text not null
) strict;

-- ⚠️ OD-10 (answered yes, 2026-11-04; ADR 0064): cash that leaves the drawer without a sale -- a paid-out,
-- a safe drop, or a banking from the drawer or the safe. The till records each one and the outbox carries it
-- as a `TillCashMsg`; the server posts the TILL_PAID_OUT / TILL_SAFE_DROP / TILL_BANKING document. Amounts are
-- positive magnitudes at 4 dp; the kind carries the direction.
create table if not exists cash_event (
  id                      text primary key,   -- uuidv7 = the document's client_ref
  shift_id                text not null references shift (id),
  kind                    text not null check (kind in ('paid_out', 'safe_drop', 'banking')),
  amount                  text not null,
  currency                text not null,
  reference               text,
  from_safe               integer not null default 0 check (from_safe in (0, 1)),
  cashier_principal_id    text not null,
  supervisor_principal_id text,
  occurred_at             text not null,
  check (from_safe = 0 or kind = 'banking'),
  check (kind <> 'paid_out' or reference is not null)
) strict;

-- spec:2089's clock-in/out. Travels up inside `Ticket.attendance` (§4.10.1) or, between sales, on the
-- next ticket -- which is why it is a table and not a field: a clock-in at 08:00 must survive until the
-- first sale at 08:04 and must not be lost if the till is closed in between.
create table if not exists attendance (
  id           text primary key,
  principal_id text not null,
  kind         text not null check (kind in ('clock_in', 'clock_out')),
  occurred_at  text not null,
  sent_at      text
) strict;

-- spec:1336: "outbox(id, ticket_id, payload jsonb, attempts, last_error, acked_at) -- written in the same
-- SQLite transaction as the ticket". §4.10.6 adds `kind`. `ref` is the id the SERVER acknowledges by
-- (§4.10.1's MessageResult): a ticket's clientRef, "<shiftId>:<kind>", a till event's or cash event's clientRef.
-- `cash_event` joined the CHECK at LOCAL_SCHEMA_VERSION 3 (⚠️ OD-10); `openPosDatabase` rebuilds an older
-- file's outbox under the new CHECK before this file runs, keeping every row.
create table if not exists outbox (
  id         text primary key,
  kind       text not null check (kind in ('ticket', 'shift', 'till_event', 'cash_event')),
  ref        text not null,
  payload    text not null,
  attempts   integer not null default 0,
  last_error text,
  acked_at   text,
  created_at text not null
) strict;
create unique index if not exists outbox_ref_idx on outbox (kind, ref);
create index if not exists outbox_pending_idx on outbox (acked_at, created_at);

-- PR 12 review (R12; proposed ADR 0056 amendment): the ticket and till-event rows whose refusal is FINAL.
-- The server refused the row (`attempts` counts refusals; `markAcked` is its only writer) and has since
-- acknowledged the close of the row's shift, after which `assertShiftKnown` refuses anything naming that shift:
-- no re-send can be accepted, and one would only overwrite the reason the needs-attention queue holds. Until
-- that close is acknowledged a refused row is re-sent like any other, so a refusal the server cures (a grant
-- restored, a period opened, a customer code freed) still posts — at the latest in the close's own batch,
-- which the server applies before it derives the drawer. A view and not a column: one definition every reader
-- shares (SqliteSyncStore, the enrol gate, the till's credit check), and a file written before it gains it on
-- its next open, because this whole file runs then. Dropped first so an older definition never survives.
drop view if exists outbox_refused;
create view outbox_refused as
  select o.id, o.kind, o.ref, o.payload, o.attempts, o.last_error, o.created_at
    from outbox o
   where o.acked_at is null and o.attempts > 0 and o.kind <> 'shift'
     and exists (select 1 from outbox c
                  where c.kind = 'shift' and c.acked_at is not null
                    and c.ref = json_extract(o.payload, '$.shiftId') || ':close');

-- ── 4. pending_customer (added at LOCAL_SCHEMA_VERSION 2, slice 6B Task 8) ────────────────────────────
-- A customer quick-created at the till (§3.7.6's Customers row, `pos.customer.create`). It is a table of
-- ADR 0057's SECOND kind -- a row the till created and owns until the server acknowledges it -- and NOT a
-- `catalogue_*` mirror: a mirror's only writer is applyChanges, and putting a locally-minted party there
-- would give the mirror a second writer, which is the whole failure mode ADR 0057 rule 1 exists to prevent.
--
-- `id` is the uuidv7 the till minted offline and is BOTH `Ticket.customerId` and `NewCustomer.id`, so a
-- re-sent ticket creates no second party (6A's quickCreateCustomer is `on conflict (company_id, code) do
-- nothing` and reads the winner back). The row is never deleted: `SqliteSyncStore.markAcked` stamps `acked_at`
-- in the same transaction that acknowledges a ticket carrying it, and the row stays -- lookups keep finding the
-- customer, preferring the mirror by id -- until the real party arrives on a catalogue page (6B's
-- historical-return persistence clarification). `clearPendingCustomers` is a manual/test helper, not the drain.
create table if not exists pending_customer (
  id           text primary key,
  code         text not null unique,
  name_en      text not null,
  name_ar      text,
  phone        text,
  created_at   text not null,
  acked_at     text
) strict;
create index if not exists pending_customer_phone_idx on pending_customer (phone);

