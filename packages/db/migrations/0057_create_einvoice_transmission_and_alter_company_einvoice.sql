-- 0057 — e-invoicing: the transmission log and the company's transmitter settings.
--
-- spec:2225 "E-invoicing / fiscalisation as a pluggable jurisdiction pack with document hash,
--            QR code, transmission log, retry, and status reconciliation."
-- spec:2226 The requirement set is verified against the authority's own documentation (ADR 0051).
--            NOTHING in this file names an endpoint, a field, a version or a threshold.
-- §4.9.3    The column list; amendment 6 adds profile_version, qr_payload, polled_at, claimed_at.
-- §3.4.7    app.company holds production rows, so its three columns are the EXPAND half: nullable,
--            no backfill, and the down drops only the columns (§3.4.5).

-- ── 1. the transmission log ───────────────────────────────────────────────────────────────────
create table app.einvoice_transmission (
  id               uuid primary key default uuidv7(),                      -- spec:2037
  tenant_id        uuid not null references app.tenant(id),                -- spec:106
  company_id       uuid not null,
  document_id      uuid not null,
  transmitter      text not null,                                          -- 'synthetic' | 'myinvois'
  profile_version  int,                                                    -- amendment 6: SAH-013 pinning
  external_id      text,                                                   -- the authority's own id
  status           text not null default 'pending',                        -- §4.9.3's six labels
  attempts         int  not null default 0,                                -- spec:2225 "retry"
  last_error       text,
  request_sha256   bytea,                                                  -- sha256 of the canonical payload
  response         jsonb,                                                  -- REDACTED (ADR 0053)
  qr_payload       text,                                                   -- amendment 6; spec:2225 "QR code"
  submitted_at     timestamptz,
  accepted_at      timestamptz,
  cancelled_at     timestamptz,
  polled_at        timestamptz,                                            -- amendment 6: the last COMPLETED remote
                                                                           -- call (submit, poll or cancel), so a
                                                                           -- transmission stuck at 'submitted' is
                                                                           -- readable without querying pg-boss
  claimed_at       timestamptz,                                            -- amendment 6: a call IN FLIGHT since this
                                                                           -- instant; null = no call in flight. Task 5
                                                                           -- sets it at claim and clears it the moment
                                                                           -- the call ends, in either direction. It is
                                                                           -- a SEPARATE column from polled_at because
                                                                           -- one column cannot mean both "started, not
                                                                           -- yet finished" and "last finished" — and
                                                                           -- conflating them refuses the poll that
                                                                           -- legitimately follows a submit
  created_at       timestamptz not null default now(),                     -- spec:106

  unique (tenant_id, id),                                                  -- §3.5.1 step 1
  unique (tenant_id, document_id),                                         -- §4.9.3 "unique (document_id)"
  foreign key (tenant_id, company_id)  references app.company  (tenant_id, id),
  foreign key (tenant_id, document_id) references app.document (tenant_id, id),

  constraint einvoice_transmission_transmitter_check
    check (transmitter in ('synthetic', 'myinvois')),                      -- §3.2: text + CHECK, never an enum (§3.4.4)
  constraint einvoice_transmission_status_check
    check (status in ('pending', 'submitted', 'accepted', 'rejected', 'cancelled', 'error')),
  constraint einvoice_transmission_attempts_check
    check (attempts >= 0),
  constraint einvoice_transmission_profile_version_check
    check (profile_version is null or profile_version > 0),
  -- A status that names a remote object must carry the remote object's id. 'rejected' may or may
  -- not: an authority that refuses at the door returns no id, and one that refuses after intake does.
  constraint einvoice_transmission_external_id_check
    check (status not in ('submitted', 'accepted', 'cancelled') or external_id is not null),
  -- The three timestamps are set once and never cleared, so a cancelled transmission keeps the
  -- accepted_at that preceded it. An equality here would forbid exactly that (SAH-041's shape).
  constraint einvoice_transmission_accepted_at_check
    check (status <> 'accepted' or accepted_at is not null),
  constraint einvoice_transmission_cancelled_at_check
    check (status <> 'cancelled' or cancelled_at is not null),
  constraint einvoice_transmission_qr_payload_check
    check (qr_payload is null or status in ('accepted', 'cancelled'))
);

comment on table app.einvoice_transmission is
  'One row per document transmitted to a fiscalisation authority (spec:2225). Never deleted: a '
  'cancellation is status = ''cancelled'' (spec:2049).';
comment on column app.einvoice_transmission.response is
  'The REDACTED remote response (ADR 0053). Never an authorization header, never a credential.';

-- The list route filters (company, status) and the reconciliation sweep reads (status, polled_at) to
-- find the transmissions whose last completed call is oldest.
create index einvoice_transmission_company_status_idx
  on app.einvoice_transmission (tenant_id, company_id, status);
create index einvoice_transmission_open_idx
  on app.einvoice_transmission (tenant_id, status, polled_at)
  where status in ('pending', 'submitted', 'error');

-- ── 2. RLS and audit (§3.5.1 steps 2 and 3) ───────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.einvoice_transmission');
-- §3.5.3 puts this table in NO set: it is audited, has an id and a created_at, and is mutable —
-- a status change from 'submitted' to 'rejected' is exactly the before/after image SAH-029/030
-- exist to preserve. No attach_stamp: the table has no *_by column and never gains one (§3.3).
call app_meta.attach_audit('app.einvoice_transmission');

-- ── 3. the company's transmitter settings (§3.4.7 expand) ─────────────────────────────────────
alter table app.company
  add column einvoice_transmitter    text,   -- null = e-invoicing OFF for this company (one column,
                                             -- so an on/off flag and a name can never disagree)
  add column einvoice_client_id      text,
  add column einvoice_credential_ref text;   -- the NAME of the secret, never the value (§4.9.3)

alter table app.company
  add constraint company_einvoice_transmitter_check
    check (einvoice_transmitter is null or einvoice_transmitter in ('synthetic', 'myinvois')),
  add constraint company_einvoice_complete_check
    check (num_nonnulls(einvoice_transmitter, einvoice_client_id, einvoice_credential_ref) in (0, 3)),
  -- The ref may name only an EINVOICE_* environment variable, so an admin cannot point it at
  -- DATABASE_URL and have the transmitter read a connection string into an Authorization header.
  -- §3.11's enumerated name is EINVOICE_CLIENT_SECRET; the pattern admits a second authority's.
  add constraint company_einvoice_credential_ref_check
    check (einvoice_credential_ref is null or einvoice_credential_ref ~ '^EINVOICE_[A-Z0-9_]+$');

comment on column app.company.einvoice_credential_ref is
  'The NAME of the environment secret the transmitter presents (§3.11). Never the value.';
