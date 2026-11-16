-- 0064_create_employee_minimal.sql — §3.10.1 "Employee master", the minimal master (spec:2075); cashiers are employees (spec:2097).
create table app.employee (
  id               uuid primary key default uuidv7(),
  tenant_id        uuid not null references app.tenant(id),
  company_id       uuid not null,
  party_id         uuid not null,                                  -- 1:1 with a party of kind 'employee'
  employee_number  text not null,
  home_branch_id   uuid not null,                                  -- BRANCH dimension value (spec:2075)
  principal_id     uuid unique references app.principal(id),       -- nullable 1:1: only staff who log in or sell (spec:2097)
  hired_on         date not null,
  terminated_on    date,                                           -- AFTER UPDATE OF terminated_on trigger arrives with 8C (migration 0093)
  created_at       timestamptz not null default now(),
  unique (company_id, employee_number),
  unique (party_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)     references app.company(tenant_id, id),
  foreign key (tenant_id, party_id)       references app.party(tenant_id, id),
  foreign key (tenant_id, home_branch_id) references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.employee');
call app_meta.attach_audit('app.employee');
-- branch_isolation is attached by 0068 (6C) if this file ran before it, or here if 0068 already exists:
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'actor_in_branch') then
    execute 'create policy branch_isolation on app.employee as restrictive to app_rw, app_migrator using (app.actor_in_branch(company_id, home_branch_id))';
  end if;
end $$;
