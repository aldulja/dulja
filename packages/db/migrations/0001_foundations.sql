-- Dulja reference schema, grown across Plan 0A Tasks 5–10.
create extension if not exists btree_gist;
create schema app;
grant usage on schema app to app_rw;
grant usage on schema app to app_auth;

create function app.current_tenant() returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create function app.current_actor() returns uuid language sql stable as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid
$$;

create procedure app_meta.enable_tenant_rls(tbl regclass) language plpgsql as $$
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);
  execute format(
    'create policy tenant_isolation on %s using (tenant_id = app.current_tenant()) with check (tenant_id = app.current_tenant())',
    tbl
  );
end
$$;

create table app.tenant (
  id uuid primary key default uuidv7(),
  name text not null,
  created_at timestamptz not null default now()
);
alter table app.tenant enable row level security;
alter table app.tenant force row level security;
create policy tenant_self on app.tenant using (id = app.current_tenant());
grant select, insert, update on app.tenant to app_rw;

create type app.principal_kind as enum ('human', 'system', 'terminal');
create table app.principal (
  id uuid primary key default uuidv7(),
  kind app.principal_kind not null,
  auth_subject text not null unique,
  email text,
  display_name text not null,
  created_at timestamptz not null default now(),
  check (
    (kind = 'system' and auth_subject like 'system:%')
    or (kind = 'terminal' and auth_subject like 'terminal:%')
    or (kind = 'human' and auth_subject not like 'system:%' and auth_subject not like 'terminal:%')
  )
);

create table app.membership (
  tenant_id uuid not null references app.tenant(id),
  principal_id uuid not null references app.principal(id) unique,
  created_at timestamptz not null default now(),
  primary key (tenant_id, principal_id)
);

alter table app.principal enable row level security;
alter table app.principal force row level security;
create policy principal_in_tenant on app.principal for select using (
  exists (
    select 1 from app.membership membership
    where membership.principal_id = id and membership.tenant_id = app.current_tenant()
  )
);
create policy principal_update_in_tenant on app.principal for update using (
  exists (
    select 1 from app.membership membership
    where membership.principal_id = id and membership.tenant_id = app.current_tenant()
  )
);
create policy principal_insert on app.principal for insert with check (app.current_tenant() is not null);
call app_meta.enable_tenant_rls('app.membership');
grant select, insert, update on app.principal, app.membership to app_rw;

grant select on app.principal, app.membership to app_auth;
create policy principal_resolver on app.principal for select to app_auth using (true);
create policy membership_resolver on app.membership for select to app_auth using (true);

create function app.resolve_principal(p_auth_subject text)
returns table (principal_id uuid, tenant_id uuid, kind app.principal_kind)
language sql security definer set search_path = app, pg_temp stable as $$
  select principal.id, membership.tenant_id, principal.kind
  from app.principal principal
  join app.membership membership on membership.principal_id = principal.id
  where principal.auth_subject = p_auth_subject
$$;

revoke all on function app.resolve_principal(text) from public;
grant execute on function app.resolve_principal(text) to app_rw;
grant create on schema app to app_auth;
alter function app.resolve_principal(text) owner to app_auth;
revoke create on schema app from app_auth;

-- ── 5. company, RBAC, fiscal periods, accounts ────────────────────────────────────────────────────────
-- Every tenant-scoped parent has unique (tenant_id, id), so children can use composite foreign keys. A plain
-- UUID foreign key would bypass RLS checks and could link a tenant to another tenant's known UUID.
create table app.company (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references app.tenant(id),
  code text not null,
  name text not null,
  base_currency char(3) not null,
  timezone text not null default 'Asia/Kuala_Lumpur',
  fx_rounding_account_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)
);
call app_meta.enable_tenant_rls('app.company');

create table app.role (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references app.tenant(id),
  code text not null,
  name_en text not null,
  name_ar text,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id)
);
call app_meta.enable_tenant_rls('app.role');

-- This global catalogue is seeded from packages/contracts/permissions.ts in Plan 0B.
create table app.permission (
  code text primary key,
  module text not null check (module in ('admin', 'accounting', 'inventory', 'hr', 'pos')),
  mutating boolean not null,
  description text not null,
  check (code like module || '.%' and code ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$')
);
grant select on app.permission to app_rw;

create table app.role_permission (
  tenant_id uuid not null,
  role_id uuid not null,
  permission_code text not null references app.permission(code),
  primary key (role_id, permission_code),
  foreign key (tenant_id, role_id) references app.role(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.role_permission');

create table app.role_assignment (
  tenant_id uuid not null references app.tenant(id),
  principal_id uuid not null references app.principal(id),
  role_id uuid not null,
  company_id uuid not null,
  granted_by uuid not null default app.current_actor() references app.principal(id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  primary key (principal_id, role_id, company_id),
  unique (tenant_id, principal_id, role_id, company_id),
  foreign key (tenant_id, role_id) references app.role(tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.role_assignment');

-- No branch rows means company-wide authority. The dimension_value FK arrives in Task 7.
create table app.role_assignment_branch (
  tenant_id uuid not null,
  principal_id uuid not null,
  role_id uuid not null,
  company_id uuid not null,
  branch_id uuid not null,
  primary key (principal_id, role_id, company_id, branch_id),
  foreign key (tenant_id, principal_id, role_id, company_id)
    references app.role_assignment(tenant_id, principal_id, role_id, company_id) on delete cascade
);
call app_meta.enable_tenant_rls('app.role_assignment_branch');

-- The authorisation predicate used by handlers, sensitive-table RLS and triggers.
create function app.actor_has(p_code text, p_company_id uuid, p_branch_id uuid default null) returns boolean
language sql stable as $$
  select exists (
    select 1 from app.principal p join app.membership m on m.principal_id = p.id
     where p.id = app.current_actor() and p.kind = 'system' and m.tenant_id = app.current_tenant()
  )
  or exists (
    select 1
      from app.role_assignment ra
      join app.role_permission rp on rp.role_id = ra.role_id
     where ra.principal_id = app.current_actor()
       and ra.company_id = p_company_id
       and rp.permission_code = p_code
       and (ra.expires_at is null or ra.expires_at > now())
       and (
         not exists (
           select 1 from app.role_assignment_branch b
            where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
         )
         or (
           p_branch_id is not null
           and exists (
             select 1 from app.role_assignment_branch b
              where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
                and b.branch_id = p_branch_id
           )
         )
       )
  )
$$;

-- No self-grant or self-escalation. The seed runs as the system principal, so the owner's first assignment passes.
create function app.forbid_self_grant() returns trigger language plpgsql as $$
begin
  if tg_table_name in ('role_assignment', 'role_assignment_branch') then
    if coalesce(new.principal_id, old.principal_id) = app.current_actor() then
      raise exception 'ERR_RBAC_SELF_GRANT: a principal cannot change their own role assignments' using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'role_permission' then
    if exists (
      select 1 from app.role_assignment ra
       where ra.role_id = coalesce(new.role_id, old.role_id)
         and ra.principal_id = app.current_actor()
         and (ra.expires_at is null or ra.expires_at > now())
    ) then
      raise exception 'ERR_RBAC_SELF_ESCALATION: a principal cannot change the permissions of a role they hold' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger role_assignment_no_self_grant before insert or update or delete on app.role_assignment
  for each row execute function app.forbid_self_grant();
create trigger role_assignment_branch_no_self_grant before insert or update or delete on app.role_assignment_branch
  for each row execute function app.forbid_self_grant();
create trigger role_permission_no_self_escalation before insert or update or delete on app.role_permission
  for each row execute function app.forbid_self_grant();

-- A terminal can only receive pos_terminal; a human can never receive it; the system principal holds no role.
create function app.assert_assignment_kind() returns trigger language plpgsql as $$
declare v_kind app.principal_kind; v_code text;
begin
  select kind into v_kind from app.principal where id = new.principal_id;
  select code into v_code from app.role where id = new.role_id;
  if v_kind = 'system' then
    raise exception 'ERR_RBAC_KIND: the system principal holds no role' using errcode = 'check_violation';
  elsif (v_kind = 'terminal') <> (v_code = 'pos_terminal') then
    raise exception 'ERR_RBAC_KIND: role % cannot be assigned to a principal of kind %', v_code, v_kind using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger role_assignment_kind before insert or update on app.role_assignment
  for each row execute function app.assert_assignment_kind();

-- A change may not leave a tenant with no unexpired holder of admin.user.manage.
create function app.keep_last_admin_assignment() returns trigger language plpgsql as $$
declare removing boolean;
begin
  if tg_op = 'DELETE' then removing := true;
  else removing := (new.expires_at is not null and new.expires_at <= now()) or new.role_id <> old.role_id or new.principal_id <> old.principal_id;
  end if;
  if removing and (old.expires_at is null or old.expires_at > now())
     and exists (select 1 from app.role_permission rp where rp.role_id = old.role_id and rp.permission_code = 'admin.user.manage')
     and not exists (
       select 1 from app.role_assignment ra join app.role_permission rp on rp.role_id = ra.role_id
        where ra.tenant_id = old.tenant_id and rp.permission_code = 'admin.user.manage'
          and (ra.expires_at is null or ra.expires_at > now())
          and (ra.principal_id, ra.role_id, ra.company_id) <> (old.principal_id, old.role_id, old.company_id)
     ) then
    raise exception 'ERR_RBAC_LAST_ADMIN: this change would leave no administrator in the tenant' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;

create function app.keep_last_admin_permission() returns trigger language plpgsql as $$
declare removing boolean;
begin
  if tg_op = 'DELETE' then removing := true;
  else removing := new.permission_code <> old.permission_code or new.role_id <> old.role_id;
  end if;
  if removing and old.permission_code = 'admin.user.manage'
     and exists (select 1 from app.role_assignment ra where ra.role_id = old.role_id and (ra.expires_at is null or ra.expires_at > now()))
     and not exists (
       select 1 from app.role_assignment ra join app.role_permission rp on rp.role_id = ra.role_id
        where ra.tenant_id = old.tenant_id and rp.permission_code = 'admin.user.manage'
          and (ra.expires_at is null or ra.expires_at > now()) and ra.role_id <> old.role_id
     ) then
    raise exception 'ERR_RBAC_LAST_ADMIN: this change would leave no administrator in the tenant' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger role_assignment_keep_last_admin before update or delete on app.role_assignment
  for each row execute function app.keep_last_admin_assignment();
create trigger role_permission_keep_last_admin before update or delete on app.role_permission
  for each row execute function app.keep_last_admin_permission();

create type app.period_status as enum ('open', 'closed', 'locked');
create table app.fiscal_period (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references app.tenant(id),
  company_id uuid not null,
  starts_on date not null,
  ends_on date not null,
  status app.period_status not null default 'open',
  closed_by uuid references app.principal(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  check (ends_on >= starts_on),
  exclude using gist (company_id with =, daterange(starts_on, ends_on, '[]') with &&)
);
call app_meta.enable_tenant_rls('app.fiscal_period');

create type app.account_type as enum ('asset', 'liability', 'equity', 'income', 'expense');
create table app.account (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references app.tenant(id),
  company_id uuid not null,
  code text not null,
  name_en text not null,
  name_ar text,
  type app.account_type not null,
  parent_id uuid,
  is_group boolean not null default false,
  currency char(3),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, parent_id) references app.account(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.account');
alter table app.company add constraint company_fx_rounding_account_fk
  foreign key (tenant_id, fx_rounding_account_id) references app.account(tenant_id, id);

grant select, insert, update on app.company, app.role, app.role_permission, app.role_assignment,
  app.role_assignment_branch, app.fiscal_period, app.account to app_rw;

-- ── 6. Document types are data; posting rules are versioned policy (RC-3, SAH-013) ────────────────────
create table app.document_type (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid not null,
  code text not null, name_en text not null, name_ar text, created_at timestamptz not null default now(),
  unique (company_id, code), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.document_type');

create table app.posting_policy (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), document_type_id uuid not null,
  version int not null, effective_from date not null, definition jsonb not null, created_at timestamptz not null default now(),
  unique (document_type_id, version), unique (tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.posting_policy');

-- Numbers are allocated by the posting service under an advisory lock, never by the client.
create table app.document_series (
  tenant_id uuid not null references app.tenant(id), company_id uuid not null, series text not null,
  fiscal_period_id uuid not null, next_number bigint not null default 1,
  primary key (company_id, series, fiscal_period_id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.document_series');

create table app.document_number_void (
  tenant_id uuid not null references app.tenant(id), company_id uuid not null, series text not null,
  fiscal_period_id uuid not null, number bigint not null, reason text not null,
  voided_by uuid not null default app.current_actor() references app.principal(id), voided_at timestamptz not null default now(),
  primary key (company_id, series, fiscal_period_id, number),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.document_number_void');

create type app.document_status as enum ('draft', 'submitted', 'approved', 'issued', 'void', 'posted', 'reversed');
create table app.document (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid not null,
  document_type_id uuid not null, posting_policy_id uuid, status app.document_status not null default 'draft', series text not null,
  fiscal_period_id uuid, number bigint, effective_date date not null, party_id uuid, currency char(3) not null,
  exchange_rate numeric(19,8) not null default 1, rate_source text, reverses_document_id uuid, client_ref uuid,
  branch_id uuid not null, attributed_to uuid references app.principal(id), created_by uuid not null default app.current_actor() references app.principal(id),
  created_at timestamptz not null default now(), posted_by uuid references app.principal(id), posted_at timestamptz,
  unique (company_id, series, fiscal_period_id, number), unique (company_id, client_ref), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id),
  foreign key (tenant_id, posting_policy_id) references app.posting_policy(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id),
  foreign key (tenant_id, reverses_document_id) references app.document(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.document');

-- Dimensions are generic so an additional reporting axis requires no schema change.
create table app.dimension_type (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid not null,
  code text not null, name_en text not null, created_at timestamptz not null default now(),
  unique (company_id, code), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.dimension_type');

create table app.dimension_value (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), dimension_type_id uuid not null,
  code text not null, name_en text not null, parent_id uuid, archived_at timestamptz, created_at timestamptz not null default now(),
  unique (dimension_type_id, code), unique (tenant_id, id),
  foreign key (tenant_id, dimension_type_id) references app.dimension_type(tenant_id, id),
  foreign key (tenant_id, parent_id) references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.dimension_value');

alter table app.role_assignment_branch add constraint role_assignment_branch_dim_fk
  foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id);
alter table app.document add constraint document_branch_fk
  foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id);

grant select, insert, update on app.document_type, app.posting_policy, app.document_series,
  app.document_number_void, app.document, app.dimension_type, app.dimension_value to app_rw;

-- ── 7. THE LEDGER. Immutable. The only financial truth. (D13, RC-2) ────────────────────────────────────
create table app.ledger_entry (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid not null,
  document_id uuid not null, line_no int not null, account_id uuid not null,
  debit numeric(19,4) not null default 0 check (debit >= 0), credit numeric(19,4) not null default 0 check (credit >= 0),
  currency char(3) not null, exchange_rate numeric(19,8) not null, base_debit numeric(19,4) not null, base_credit numeric(19,4) not null,
  effective_date date not null, fiscal_period_id uuid not null, posting_policy_id uuid not null,
  posted_at timestamptz not null default now(), posted_by uuid not null default app.current_actor() references app.principal(id),
  check (not (debit > 0 and credit > 0)), check (base_debit = round(debit * exchange_rate, 4)), check (base_credit = round(credit * exchange_rate, 4)),
  unique (document_id, line_no), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, account_id) references app.account(tenant_id, id),
  foreign key (tenant_id, fiscal_period_id) references app.fiscal_period(tenant_id, id),
  foreign key (tenant_id, posting_policy_id) references app.posting_policy(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.ledger_entry');
create index ledger_entry_account_date_idx on app.ledger_entry (company_id, account_id, effective_date);
create index ledger_entry_company_date_idx on app.ledger_entry (company_id, effective_date);

create table app.ledger_entry_dimension (
  tenant_id uuid not null references app.tenant(id), entry_id uuid not null, dimension_type_id uuid not null, dimension_value_id uuid not null,
  primary key (entry_id, dimension_type_id),
  foreign key (tenant_id, entry_id) references app.ledger_entry(tenant_id, id),
  foreign key (tenant_id, dimension_type_id) references app.dimension_type(tenant_id, id),
  foreign key (tenant_id, dimension_value_id) references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.ledger_entry_dimension');

create function app.forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'ERR_TABLE_IMMUTABLE: % is append-only', tg_table_name using errcode = 'check_violation';
end $$;
create trigger ledger_entry_immutable before update or delete on app.ledger_entry for each row execute function app.forbid_change();
create trigger ledger_entry_dimension_immutable before update or delete on app.ledger_entry_dimension for each row execute function app.forbid_change();

create function app.assert_period_open() returns trigger language plpgsql as $$
declare st app.period_status;
begin
  select status into st from app.fiscal_period where id = new.fiscal_period_id;
  if st is distinct from 'open' then
    raise exception 'ERR_PERIOD_NOT_OPEN: period % is %', new.fiscal_period_id, coalesce(st::text, 'missing') using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger ledger_entry_period_open before insert on app.ledger_entry for each row execute function app.assert_period_open();

create function app.assert_document_balanced() returns trigger language plpgsql as $$
declare diff numeric(19,4);
begin
  select coalesce(sum(base_debit) - sum(base_credit), 0) into diff from app.ledger_entry where document_id = new.document_id;
  if diff <> 0 then
    raise exception 'ERR_LEDGER_UNBALANCED: document % is off by %', new.document_id, diff using errcode = 'check_violation';
  end if;
  return null;
end $$;
create constraint trigger ledger_entry_balanced after insert on app.ledger_entry deferrable initially deferred for each row execute function app.assert_document_balanced();

grant select, insert on app.ledger_entry, app.ledger_entry_dimension to app_rw;

-- ── 8. Audit log: append-only, server-supplied actor, hash-chained ────────────────────────────────────
create table app.audit_log (
  seq bigint generated always as identity primary key, tenant_id uuid not null references app.tenant(id),
  actor_id uuid not null default app.current_actor() references app.principal(id) deferrable initially deferred,
  occurred_at timestamptz not null default now(), table_name text not null, row_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')), before jsonb, after jsonb, prev_hash bytea, hash bytea not null
);
call app_meta.enable_tenant_rls('app.audit_log');
create index audit_log_tenant_seq_idx on app.audit_log (tenant_id, seq desc);
create trigger audit_log_immutable before update or delete on app.audit_log for each row execute function app.forbid_change();
create function app.audit_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  select hash into prev from app.audit_log where tenant_id = new.tenant_id order by seq desc limit 1;
  new.prev_hash := prev;
  new.hash := sha256(coalesce(prev, ''::bytea) || convert_to(new.tenant_id::text || '|' || new.actor_id::text || '|' || extract(epoch from new.occurred_at)::text || '|' || new.table_name || '|' || new.row_id || '|' || new.action || '|' || coalesce(new.before::text, '') || '|' || coalesce(new.after::text, ''), 'UTF8'));
  return new;
end $$;
create trigger audit_log_chain before insert on app.audit_log for each row execute function app.audit_chain();
create function app.audit_row() returns trigger language plpgsql security definer set search_path = app, pg_temp as $$
declare rec jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end; v_tenant uuid; v_row_id text; v_keys text := coalesce(tg_argv[1], '');
begin
  v_tenant := case coalesce(tg_argv[0], 'tenant_column') when 'self_id' then (rec ->> 'id')::uuid when 'current_tenant' then app.current_tenant() else (rec ->> 'tenant_id')::uuid end;
  if v_keys <> '' then select string_agg(rec ->> k, '/' order by ord) into v_row_id from unnest(string_to_array(v_keys, ',')) with ordinality as t(k, ord); else v_row_id := rec ->> 'id'; end if;
  insert into app.audit_log (tenant_id, table_name, row_id, action, before, after) values (v_tenant, tg_table_name, v_row_id, lower(tg_op), case when tg_op = 'INSERT' then null else to_jsonb(old) end, case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return null;
end $$;
create procedure app_meta.attach_audit(tbl regclass, mode text default 'tenant_column', key_cols text default '') language plpgsql as $$ begin execute format('create trigger audit_row after insert or update or delete on %s for each row execute function app.audit_row(%L, %L)', tbl, mode, key_cols); end $$;
call app_meta.attach_audit('app.tenant', 'self_id');
call app_meta.attach_audit('app.principal', 'current_tenant');
call app_meta.attach_audit('app.membership', 'tenant_column', 'tenant_id,principal_id');
call app_meta.attach_audit('app.company'); call app_meta.attach_audit('app.role'); call app_meta.attach_audit('app.role_permission', 'tenant_column', 'role_id,permission_code'); call app_meta.attach_audit('app.role_assignment', 'tenant_column', 'principal_id,role_id,company_id'); call app_meta.attach_audit('app.role_assignment_branch', 'tenant_column', 'principal_id,role_id,company_id,branch_id'); call app_meta.attach_audit('app.fiscal_period'); call app_meta.attach_audit('app.account'); call app_meta.attach_audit('app.document_type'); call app_meta.attach_audit('app.posting_policy'); call app_meta.attach_audit('app.document_series', 'tenant_column', 'company_id,series,fiscal_period_id'); call app_meta.attach_audit('app.document_number_void', 'tenant_column', 'company_id,series,fiscal_period_id,number'); call app_meta.attach_audit('app.document'); call app_meta.attach_audit('app.dimension_type'); call app_meta.attach_audit('app.dimension_value');
grant select on app.audit_log to app_rw;

create function app.stamp_actor() returns trigger language plpgsql as $$
declare col text := tg_argv[0]; oldv text; newv text;
begin
  newv := to_jsonb(new) ->> col;
  if tg_op = 'INSERT' then
    if newv is not null then new := jsonb_populate_record(new, jsonb_build_object(col, app.current_actor())); end if;
  else
    oldv := to_jsonb(old) ->> col;
    if oldv is null and newv is not null then new := jsonb_populate_record(new, jsonb_build_object(col, app.current_actor()));
    elsif oldv is not null and newv is distinct from oldv then raise exception 'ERR_ACTOR_IMMUTABLE: % cannot be changed', col using errcode = 'check_violation'; end if;
  end if;
  return new;
end $$;
create procedure app_meta.attach_stamp(tbl regclass, col text) language plpgsql as $$ begin execute format('create trigger stamp_%s before insert or update on %s for each row execute function app.stamp_actor(%L)', col, tbl, col); end $$;
call app_meta.attach_stamp('app.role_assignment', 'granted_by'); call app_meta.attach_stamp('app.document_number_void', 'voided_by'); call app_meta.attach_stamp('app.document', 'created_by'); call app_meta.attach_stamp('app.document', 'posted_by'); call app_meta.attach_stamp('app.fiscal_period', 'closed_by'); call app_meta.attach_stamp('app.ledger_entry', 'posted_by');

-- ── 9. POS terminals, idempotency keys, and final application privileges ──────────────────────────────
create table app.pos_terminal (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid not null,
  branch_id uuid not null, principal_id uuid not null unique references app.principal(id), name text not null,
  device_public_key bytea not null, enrolled_by uuid not null default app.current_actor() references app.principal(id),
  enrolled_at timestamptz not null default now(), revoked_at timestamptz, created_at timestamptz not null default now(), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id), foreign key (tenant_id, branch_id) references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.pos_terminal');
call app_meta.attach_audit('app.pos_terminal');
call app_meta.attach_stamp('app.pos_terminal', 'enrolled_by');
create table app.idempotency_key (
  tenant_id uuid not null references app.tenant(id), principal_id uuid not null references app.principal(id), key text not null,
  request_hash bytea not null, response_code int, response_body jsonb, created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours', primary key (tenant_id, principal_id, key)
);
call app_meta.enable_tenant_rls('app.idempotency_key');
revoke all on all tables in schema app from app_rw;
grant select, insert, update on all tables in schema app to app_rw;
revoke update, delete on app.ledger_entry, app.ledger_entry_dimension from app_rw;
revoke insert, update, delete on app.audit_log from app_rw;
revoke insert, update on app.permission from app_rw;
grant delete on app.idempotency_key, app.role_permission, app.role_assignment_branch to app_rw;
alter default privileges for role app_migrator in schema app grant select, insert, update on tables to app_rw;
