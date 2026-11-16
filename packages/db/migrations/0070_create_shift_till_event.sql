-- 0070_create_shift_till_event.sql
-- §4.6.5 app.shift and §4.6.1 app.till_event — the server side of the till's shift (spec:1331, 1352, 1354).
-- Both tables take Form A of the branch_isolation family (§4.5.6): a NOT NULL branch key, attached in the
-- table's own migration from 6C onward (§3.5.1 step 7), which is what makes the branch_isolation_policy
-- linter rule a build failure rather than a review note.

-- ── 1. app.shift ───────────────────────────────────────────────────────────────────────────────────────
-- `id` carries NO default: it is the uuidv7 the till minted when the drawer was counted in, so re-sending
-- the `open` message is idempotent on the primary key (§4.10.1). The `id_column` linter rule checks only
-- that the column exists (plan0A:2748), so the absent default is legal and deliberate.
create table app.shift (
  id                      uuid primary key,
  tenant_id               uuid not null references app.tenant(id),
  company_id              uuid not null,
  branch_id               uuid not null,
  terminal_id             uuid not null,
  -- ATTRIBUTION, never `*_by`: on a shift synced up by a terminal the acting principal is the TERMINAL, and
  -- a stamped `opened_by` would silently replace the cashier with it — SAH-044 in reverse (§3.3).
  opened_principal_id     uuid not null references app.principal(id),
  opened_at               timestamptz not null,
  opening_float           numeric(19,4) not null,
  currency                char(3) not null,
  closed_at               timestamptz,
  closed_principal_id     uuid references app.principal(id),
  -- The ONLY cash figure the till sends (§4.10.1 ShiftOpenClose.countedCash).
  counted_cash            numeric(19,4),
  -- Derived server-side from app.ledger_entry at close (contracts §4.6.5 + amendment A3). Never sent.
  expected_cash           numeric(19,4),
  -- counted_cash - expected_cash. POSITIVE IS OVER, negative is short.
  over_short              numeric(19,4),
  over_short_document_id  uuid,
  created_at              timestamptz not null default now(),
  constraint shift_close_is_atomic check (
    (closed_at is null) = (closed_principal_id is null)
    and (closed_at is null) = (counted_cash is null)
    and (closed_at is null) = (expected_cash is null)
    and (closed_at is null) = (over_short is null)),
  constraint shift_opening_float_non_negative check (opening_float >= 0),
  constraint shift_over_short_is_the_difference check (
    over_short is null or over_short = counted_cash - expected_cash),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)             references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)              references app.dimension_value(tenant_id, id),   -- amendment A1
  foreign key (tenant_id, terminal_id)            references app.pos_terminal(tenant_id, id),
  foreign key (tenant_id, over_short_document_id) references app.document(tenant_id, id)           -- amendment A1
);

-- The Z-report history parameter shape (§4.16.1: "the same code with a date-range parameter") reads this.
create index shift_branch_opened_idx on app.shift (company_id, branch_id, opened_at desc);
-- The close path and every report resolve a shift's tickets through document.shift_id, which 6A's 0061
-- added with no key (amendment A2 records why 0070 adds none either). The index is what keeps that read
-- from being a sequential scan of app.document on every close.
create index document_shift_idx on app.document (shift_id) where shift_id is not null;

call app_meta.enable_tenant_rls('app.shift');
call app_meta.attach_audit('app.shift');
-- Form A (§4.5.6): a NOT NULL branch key. `shift` is not in AUDIT_EXEMPT — a close is an UPDATE, and its
-- before/after images are the record of who declared what count.
create policy branch_isolation on app.shift as restrictive
  using (app.actor_in_branch(company_id, branch_id));

-- ── 2. app.till_event ──────────────────────────────────────────────────────────────────────────────────
-- Append-only events on the ticket stream (spec:1354). IMMUTABLE and AUDIT_EXEMPT (§3.5.3): an audit row
-- per event would be a byte-for-byte second copy of a row nothing may ever change.
create table app.till_event (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  branch_id              uuid not null,
  terminal_id            uuid not null,
  shift_id               uuid not null,
  kind                   text not null,
  ticket_document_id     uuid,
  cashier_principal_id   uuid not null references app.principal(id),
  supervisor_principal_id uuid references app.principal(id),
  occurred_at            timestamptz not null,
  reason                 text,
  client_ref             uuid not null,
  created_at             timestamptz not null default now(),
  constraint till_event_kind_check check (kind in ('no_sale', 'drawer_open', 'void')),
  -- A void is an event ABOUT a ticket; the other two are about the drawer and name none.
  constraint till_event_ticket_only_on_void check (kind = 'void' or ticket_document_id is null),
  -- §4.6.1 declares client_ref globally unique. It is the till's own uuidv7, so a collision is not a real
  -- event, and the global key is what makes re-sending the message idempotent with no company in hand.
  unique (client_ref),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)         references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)          references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, terminal_id)        references app.pos_terminal(tenant_id, id),
  foreign key (tenant_id, shift_id)           references app.shift(tenant_id, id),
  foreign key (tenant_id, ticket_document_id) references app.document(tenant_id, id)
);

create index till_event_shift_idx on app.till_event (shift_id, occurred_at);

call app_meta.enable_tenant_rls('app.till_event');
-- No attach_audit: AUDIT_EXEMPT (§3.5.3).
create trigger till_event_immutable before update or delete on app.till_event
  for each row execute function app.forbid_change();
revoke update, delete on app.till_event from app_rw;
create policy branch_isolation on app.till_event as restrictive
  using (app.actor_in_branch(company_id, branch_id));

