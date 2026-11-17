-- 0060_create_terminal_enrolment_needs_attention.sql
-- §3.7.5 terminal identity (spec:1322) · §3.7.3 "Rejected tickets … surface in a shop-level 'needs attention'
-- queue — never silently dropped" (spec:1305) · contracts §4.10.3, §4.10.4 · ADR 0055.

-- ── 1. one-time enrolment codes ───────────────────────────────────────────────────────────────────────
-- Only the HASH is stored. The code is shown once, in the back office, and is a bearer secret exactly like a
-- password-reset link; storing it would make the enrolment table a credential store (LEGACY-025, LEGACY-028 — the
-- PIN is the ONLY credential this application hashes, and this is not a credential, it is a one-shot ticket).
-- The three columns §4.10.3's sketch did not carry — `code_hash bytea` (not `text`), `name`, `terminal_code`
-- with its per-company reservation — are Task 0 amendment 10, which restated the sketch to match this file.
-- The reservation is an EXCLUSION, not the `unique (company_id, terminal_code)` amendment 10 first wrote (PR 12
-- review, finding 14, which restates §4.10.3 again): a plain unique covered expired, never-redeemed rows too, and
-- `app_rw` cannot delete an enrolment, so a code nobody redeemed inside its hour reserved its terminal code for ever.
create table app.terminal_enrolment (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  branch_id    uuid not null,                                   -- the BRANCH dimension value the terminal will inherit
  code_hash    bytea not null unique,                           -- sha256 of the one-time code
  name         text not null,                                   -- the terminal's display name, chosen at issue
  terminal_code text not null,                                  -- becomes pos_terminal.code — the numbering suffix (§4.3.6)
  issued_by    uuid not null default app.current_actor() references app.principal(id),
  expires_at   timestamptz not null,
  redeemed_at  timestamptz,
  terminal_id  uuid,                                            -- set at redemption
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  check (expires_at > created_at),
  -- A terminal code is HELD while an enrolment that promises it is live — [created_at, expires_at) — and for
  -- ever once one is redeemed, because the terminal then owns it as its numbering suffix (§4.3.6). Two
  -- holdings of one code in one company may not overlap, so a live or redeemed enrolment refuses a second
  -- issue (23P01, mapped to ERR_CONFLICT_UNIQUE by `createEnrolment`) while an expired, unredeemed one holds
  -- nothing and needs no delete. Like a unique index it is checked against uncommitted rows too, so two
  -- concurrent issues of one code cannot both commit, nor can an issue and a redemption racing at the expiry.
  constraint terminal_enrolment_terminal_code_excl exclude using gist (
    company_id with =,
    terminal_code with =,
    tstzrange(created_at, case when redeemed_at is null then expires_at else 'infinity' end) with &&
  ),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)   references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, terminal_id) references app.pos_terminal(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.terminal_enrolment');
call app_meta.attach_audit('app.terminal_enrolment');
call app_meta.attach_stamp('app.terminal_enrolment', 'issued_by');
-- branch_isolation Form A is attached by 6C's 0068 (§4.5.6, Task 0 amendment 4).

-- ── 2. the pre-tenant door (contracts §4.1 — the second app_auth-owned function) ───────────────────────
-- The till presenting a code has no tenant, no principal and no session: it is exactly the position
-- app.resolve_principal was built for, and this is that pattern applied once more. It returns the tenant and
-- nothing else useful, so a brute-force attempt learns only "that code is not a code".
-- ⚠️ The two statements below are the whole reason this door works, and Plan 0A learned it the hard way
-- (plan0A:1021-1026, its v1.1 fix #3). `enable_tenant_rls` above issued FORCE ROW LEVEL SECURITY and a single
-- `tenant_isolation` policy `using (tenant_id = app.current_tenant())`. Inside a SECURITY DEFINER body owned by
-- `app_auth`, `current_user` is `app_auth` — which is not the table's owner and has no BYPASSRLS (only a
-- superuser can grant that, and Supabase's `postgres` is not one), so RLS applies to it — and the call runs
-- with NO tenant set, so `app.current_tenant()` is NULL and `tenant_isolation` yields ZERO ROWS. Worse,
-- plan0A:2564's default privileges grant to `app_rw` only, so `app_auth` does not even hold SELECT here.
-- Without both lines the function compiles, runs, and silently answers "that is not a code" to every valid
-- code in the system. This is `principal_resolver` / `membership_resolver` (plan0A:1024-1026) applied once more.
grant select on app.terminal_enrolment to app_auth;
create policy enrolment_resolver on app.terminal_enrolment for select to app_auth using (true);

create function app.resolve_enrolment(p_code_hash bytea)
returns table (enrolment_id uuid, tenant_id uuid, company_id uuid, branch_id uuid)
language sql stable security definer set search_path = app, pg_temp as $$
  select e.id, e.tenant_id, e.company_id, e.branch_id
    from app.terminal_enrolment e
   where e.code_hash = p_code_hash
     and e.redeemed_at is null
     and e.expires_at > now()
$$;
revoke all on function app.resolve_enrolment(bytea) from public;
grant execute on function app.resolve_enrolment(bytea) to app_rw;
grant create on schema app to app_auth;                       -- ALTER … OWNER TO needs CREATE on the schema
alter function app.resolve_enrolment(bytea) owner to app_auth;
revoke create on schema app from app_auth;                    -- ownership persists; app_auth is back to USAGE only

-- ── 2b. the signed-request replay guard (PR 12 review, extra finding E1; ADR 0055 decision 7) ──────────────
-- A signed /v1/sync/* request verifies for ±300 s around the server's clock and mints a fresh 15-minute
-- terminal JWT, so without this table a captured request could be replayed for the whole window. One row per
-- terminal; `seen` maps the sha256 (hex) of each canonical signed message the terminal has already spent to its
-- X-Terminal-Timestamp, and every write prunes the entries older than twice the window, which the skew check
-- would refuse anyway. One row, not one row per request: `app_rw` holds DELETE on no table outside contracts
-- §3.5.4's pinned five, so a per-request row could never be pruned. The upsert's row lock is the race guard —
-- a second copy of one request waits for the first to commit, re-reads the row, finds its digest and claims
-- nothing. Distinct requests (the till's catalogue and ticket loops run concurrently) carry distinct digests
-- and both succeed, in whichever order they arrive: no ordering of timestamps is imposed.
-- AUDIT_EXEMPT like `idempotency_key` (lint-schema.ts): it is per-request transport state, and an audited
-- write on every catalogue poll would grow app.audit_log without bound and queue each poll on the audit chain.
create table app.terminal_request_guard (
  id          uuid primary key default uuidv7(),
  tenant_id   uuid not null references app.tenant(id),
  terminal_id uuid not null unique,
  seen        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, terminal_id) references app.pos_terminal(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.terminal_request_guard');

-- ── 3. the needs-attention queue (spec:1305) ──────────────────────────────────────────────────────────
-- `payload` is the WHOLE rejected ticket, so a rejection is recoverable from the server alone even if the
-- till has been reimaged. That is what "never silently dropped" has to mean to be worth anything.
create table app.needs_attention (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  branch_id    uuid not null,
  terminal_id  uuid,
  client_ref   uuid not null,
  payload      jsonb not null,
  error_code   text not null,                                  -- an ErrCode (§4.2.4) — an open registry, so text
  error_detail text not null,
  resolved_by  uuid references app.principal(id),              -- NULL until resolved; stamped, never supplied
  resolved_at  timestamptz,
  resolution_note text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (company_id, client_ref),                             -- one open row per ticket: a re-send updates, never duplicates
  check ((resolved_by is null) = (resolved_at is null)),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)   references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, terminal_id) references app.pos_terminal(tenant_id, id)
);
create index needs_attention_open_idx on app.needs_attention (company_id, branch_id, created_at) where resolved_at is null;
call app_meta.enable_tenant_rls('app.needs_attention');
call app_meta.attach_audit('app.needs_attention');
call app_meta.attach_stamp('app.needs_attention', 'resolved_by');
-- stamp_actor on INSERT overwrites only a NON-NULL supplied value (plan0A:2370-2376), so a row inserted with
-- resolved_by NULL stays NULL; the UPDATE that first sets it is stamped with app.current_actor(); and any later
-- change raises ERR_ACTOR_IMMUTABLE. Exactly the lifecycle this column wants, with no bespoke trigger.
-- branch_isolation Form A is attached by 6C's 0068.

comment on table app.needs_attention is
  'Every ticket the sync apply refused, with the payload that produced it (spec:1305). Never a deletion: resolved_at closes a row.';
