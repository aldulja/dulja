-- ── 0084_create_statutory_scheme_rate_table.sql ────────────────────────────────────────────────
-- §3.10.1 "Statutory schemes as data" (spec:2080). A scheme is a ROW, never an enum, so a levy the
-- owner confirms under OD-14 is data and not a migration. A rate table is version-controlled data
-- with a source and two DIFFERENT principals behind it (LEGACY-078, LEGACY-020).
-- THIS FILE STATES NO RATE, THRESHOLD, CEILING OR FORMULA (spec:2080, hazard 1). It states where
-- one may be stored and who has to sign it.

create table app.statutory_scheme (
  id                           uuid primary key default uuidv7(),
  tenant_id                    uuid not null references app.tenant(id),
  company_id                   uuid not null,
  code                         text not null,          -- free text, so a confirmed levy is DATA (spec:2080)
  name_en                      text not null,
  name_ar                      text,
  payable_account_id           uuid,                   -- 8B's payroll chart seed sets this (amendment A2)
  employer_expense_account_id  uuid,                   -- likewise 8B's
  authority_party_id           uuid,                   -- the vendor party 8C's remittance PAYMENT is made to
  employer_registration        text,                   -- ⚠️ OD-23; the PRIMARY store (amendment A3, spec:2088 "never a blob")
  rounding_mode                text not null default 'HALF_AWAY_FROM_ZERO',
  created_at                   timestamptz not null default now(),
  constraint statutory_scheme_rounding_mode_check
    check (rounding_mode in ('HALF_AWAY_FROM_ZERO', 'HALF_EVEN', 'TOWARD_ZERO', 'AWAY_FROM_ZERO')),
  -- The rate-table schema's own `scheme` pattern (§4.12.3), so a scheme row and a table's `scheme` cannot disagree.
  constraint statutory_scheme_code_check check (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)                  references app.company(tenant_id, id),
  foreign key (tenant_id, payable_account_id)          references app.account(tenant_id, id),
  foreign key (tenant_id, employer_expense_account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, authority_party_id)          references app.party(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.statutory_scheme');
call app_meta.attach_audit('app.statutory_scheme');

comment on column app.statutory_scheme.rounding_mode is
  'The FALLBACK rounding for this scheme, applied through the one round() of §4.2.1 when a rate table declares none. It is a SYSTEM default (the same value every other Dulja money path uses), not an authority claim; a table that declares rounding_mode overrides it, which is what LEGACY-019 asks for ("each scheme''s rounding rule is declared in its table").';
comment on column app.statutory_scheme.employer_registration is
  '⚠️ OD-23. The employer''s registration number with this authority. Relational, per scheme -- spec:2088 forbids a blob.';

-- The join table's second FK could not be written in 0083, which ran before this table existed (A13).
alter table app.pay_component_scheme
  add constraint pay_component_scheme_scheme_fk
  foreign key (tenant_id, scheme_id) references app.statutory_scheme(tenant_id, id);

-- A component and a scheme of two DIFFERENT companies of one tenant cannot be joined. The composite FKs bound the
-- tenant only (RLS bounds nothing more), and the join carries no company_id of its own, so this trigger is what
-- keeps one company's applicability claim off another's scheme. It raises SQLSTATE 23503 -- the FK class -- so the
-- API answers ERR_CONFLICT_REFERENCE exactly as it does for an unknown scheme id. An id that names no visible scheme
-- is left to pay_component_scheme_scheme_fk, which fires at the end of the statement.
create function app.assert_pay_component_scheme_company() returns trigger language plpgsql as $$
declare v_component_company uuid; v_scheme_company uuid;
begin
  select c.company_id into v_component_company from app.pay_component c where c.id = new.component_id;
  select s.company_id into v_scheme_company from app.statutory_scheme s where s.id = new.scheme_id;
  if v_scheme_company is not null and v_component_company is distinct from v_scheme_company then
    raise exception 'pay component % and statutory scheme % belong to different companies', new.component_id, new.scheme_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;

create trigger pay_component_scheme_same_company
  before insert or update on app.pay_component_scheme
  for each row execute function app.assert_pay_component_scheme_company();

create table app.statutory_rate_table (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  scheme_id      uuid not null,
  version        int  not null check (version > 0),
  effective_from date not null,
  effective_to   date,
  definition     jsonb not null,        -- validated against packages/domain/payroll/rate-table.schema.json (§4.12.3)
  source         text not null,         -- authority / publication / retrieved_on, flattened for display; the structured copy is `definition.source`
  loaded_by      uuid not null default app.current_actor() references app.principal(id),   -- stamped
  verified_by    uuid references app.principal(id),                                        -- stamped on UPDATE OF verified_at
  verified_at    timestamptz,
  created_at     timestamptz not null default now(),
  unique (scheme_id, version),
  unique (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  check ((verified_at is null) = (verified_by is null)),
  foreign key (tenant_id, scheme_id) references app.statutory_scheme(tenant_id, id)
);
create index statutory_rate_table_effective_idx
  on app.statutory_rate_table (scheme_id, effective_from desc) where verified_at is not null;
create index statutory_rate_table_lapse_idx
  on app.statutory_rate_table (effective_to) where effective_to is not null and verified_at is not null;

call app_meta.enable_tenant_rls('app.statutory_rate_table');
call app_meta.attach_audit('app.statutory_rate_table');
call app_meta.attach_stamp('app.statutory_rate_table', 'loaded_by');
call app_meta.attach_stamp('app.statutory_rate_table', 'verified_by');

-- ── verified_by <> loaded_by, and a verified table is frozen (spec:2080, 1651-1652; LEGACY-020, 041) ──
-- The comparison is app.current_actor() against OLD.loaded_by, NOT against NEW.verified_by. BEFORE
-- ROW triggers on one table fire in TRIGGER-NAME order, so whether stamp_verified_by has already
-- replaced NEW.verified_by by now turns on how two names happen to sort, and NEW.verified_by may
-- still hold whatever the caller sent -- the value LEGACY-044 says never to trust. Reading the session
-- and the immutable loaded_by is order-independent: stamp_actor raises ERR_ACTOR_IMMUTABLE on any
-- change to a non-null *_by value, so loaded_by cannot move under us.
--
-- An INSERT is refused when it arrives already verified: both stamps would write the same session actor into
-- loaded_by and verified_by, so a verified insert IS a self-verification (the plan's trigger was UPDATE-only, which
-- left that door open to a direct app_rw insert).
create function app.assert_rate_table_verifier() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.verified_at is not null or new.verified_by is not null then
      raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % is loaded unverified; verification requires a different principal (spec:2080)',
        new.version, new.scheme_id using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.verified_at is null and new.verified_at is not null then
    if app.current_actor() = old.loaded_by then
      raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % was loaded by this principal; verification requires a different principal (spec:2080)',
        old.version, old.scheme_id using errcode = 'check_violation';
    end if;
  end if;
  if old.verified_at is not null and (
       new.definition     is distinct from old.definition
    or new.version        is distinct from old.version
    or new.scheme_id      is distinct from old.scheme_id
    or new.effective_from is distinct from old.effective_from
    or new.source         is distinct from old.source
    or new.verified_at    is distinct from old.verified_at) then
    -- effective_to is deliberately NOT in the list above and the message must not claim it is: a
    -- successor version has to be able to close its predecessor's open window, which is an UPDATE of
    -- effective_to on a verified row. Every other field is frozen, the verification itself included.
    raise exception 'ERR_HR_SELF_VERIFY: rate table version % of scheme % is already verified; its definition, version, effective_from, source and verification are frozen (effective_to may still be closed by a successor). Load a NEW version rather than editing a signed one (LEGACY-041, spec:2080)',
      old.version, old.scheme_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger statutory_rate_table_verifier
  before insert or update on app.statutory_rate_table
  for each row execute function app.assert_rate_table_verifier();

comment on table app.statutory_rate_table is
  'spec:2080. The PRIMARY load path is the seed pull request (packages/db/seed/my/statutory/<scheme>/vN.json), so every change is a reviewed diff (LEGACY-078); the runtime statutory-table load is BREAK-GLASS (ADR 0073). No file under seed/my/statutory/<scheme>/ exists until OD-23 supplies verified tables.';
