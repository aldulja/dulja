-- 0068_create_branch_isolation_policies.sql — §4.5.6 in full; spec:1566–1569, 2166; LEGACY-042, LEGACY-045.
-- Phases 1-5 relied on app.actor_has(code, company, branch) in handlers and triggers. This file adds the
-- ROW-level half, so a missed handler check cannot leak another branch's rows. Five forms, no sixth.

-- ── 1. the two predicates ───────────────────────────────────────────────────────────────────────────
-- The system principal passes (jobs must run, R8 spec:2179); a principal with no role_assignment_branch
-- rows is company-wide by construction, which is app.actor_has's own NULL-branch rule (spec:2166).
create function app.actor_in_branch(p_company_id uuid, p_branch_id uuid) returns boolean language sql stable as $$
  select exists (select 1 from app.principal p join app.membership m on m.principal_id = p.id
                  where p.id = app.current_actor() and p.kind = 'system' and m.tenant_id = app.current_tenant())
      or exists (select 1 from app.role_assignment ra
                  where ra.principal_id = app.current_actor() and ra.company_id = p_company_id and (ra.expires_at is null or ra.expires_at > now())
                    and (not exists (select 1 from app.role_assignment_branch b where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id)
                         or exists (select 1 from app.role_assignment_branch b where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id and b.branch_id = p_branch_id)))
$$;

-- Stock lives in warehouses, not branches: the stock tables carry warehouse_id and no branch column. This
-- resolves the warehouse's branch, bound to the SUPPLIED company (w.company_id = p_company_id), so a row
-- cannot borrow another company's warehouse to pass. The in-transit exception is written TWICE, and both
-- copies are needed (ADR 0062, 2026-10-08): this select is itself subject to app.warehouse's own policy
-- (Form A" below), which is what lets another branch see the in-transit row at all; and the `w.kind =
-- 'in_transit'` here is what then admits that branch to the movements, layers and stock_on_hand rows
-- against it. The corridor belongs to the RECEIVING branch (ADR 0043 decision 1), which passes
-- actor_in_branch on it directly; the branch both copies admit is the SENDING one, whose principal fails
-- actor_in_branch on the corridor's branch key when it posts a dispatch into it (ADR 0062's 2026-10-23
-- amendment). A receipt by a principal restricted to the receiving branch is refused by Form A on the
-- dispatch's `document`, not here.
create function app.actor_in_warehouse(p_company_id uuid, p_warehouse_id uuid) returns boolean language sql stable as $$
  select exists (select 1 from app.warehouse w
                  where w.id = p_warehouse_id and w.company_id = p_company_id
                    and (w.kind = 'in_transit' or app.actor_in_branch(w.company_id, w.branch_id)))
$$;

-- app.role_assignment_branch carries NO branch_isolation policy, and this is not an oversight: the
-- predicate above SELECTS from it, so a restrictive policy calling actor_in_branch on that table is
-- self-referential and PostgreSQL aborts every read of it -- and therefore every authorisation decision
-- in the system -- with "infinite recursion detected in policy for relation role_assignment_branch".
-- The table is the branch GRANT, not branch-scoped data; it is already tenant-isolated (ADR 0062).

-- ── 2. FORM A — a NOT NULL branch key ───────────────────────────────────────────────────────────────
-- document, pos_terminal (0001); pos_cashier (0065), branch_pos_policy (0066), attendance_event (0067);
-- terminal_enrolment and needs_attention (6A, 0060 — created BEFORE this file, so §3.5.1 step 7 could not
-- attach their form and this file must). 6D adds shift and till_event in 0070.
create policy branch_isolation on app.document            as restrictive using (app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.pos_terminal        as restrictive using (app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.pos_cashier         as restrictive using (app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.branch_pos_policy   as restrictive using (app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.attendance_event    as restrictive using (app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.terminal_enrolment  as restrictive to app_rw, app_migrator using (app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.needs_attention     as restrictive using (app.actor_in_branch(company_id, branch_id));

-- ── 3. FORM A" — app.warehouse: Form A PLUS the in-transit exception ────────────────────────────────
-- An in-transit warehouse has a NOT NULL branch_id like any other — the RECEIVING branch's (ADR 0043) — so
-- under plain Form A it is visible only to that branch. But a two-step transfer IS a dispatch from branch A
-- into B's in-transit warehouse and a receipt by branch B (spec:2160 gives branch_manager "receiving
-- transfers"), and actor_in_warehouse reads this table -- so if the in-transit row is hidden from the SENDING
-- branch A, A's `exists` returns false and every movement, layer and stock_on_hand row its dispatch writes
-- against it is refused. The exception belongs HERE, on the warehouse row (corrected 2026-10-23: this note
-- had said B; ADR 0062's amendment records why a B-only principal still cannot receive).
create policy branch_isolation on app.warehouse as restrictive
  using (kind = 'in_transit' or app.actor_in_branch(company_id, branch_id));

-- ── 4. FORM A′ — app.employee, whose branch key is named home_branch_id ─────────────────────────────
-- 0064 attaches this itself when it runs AFTER 0068 (the 8A-first order, §4.6.2's do-block), so this
-- statement is guarded in return. Exactly one of the two guards fires, whichever order the two files ran in.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'app' and tablename = 'employee' and policyname = 'branch_isolation') then
    execute 'create policy branch_isolation on app.employee as restrictive to app_rw, app_migrator using (app.actor_in_branch(company_id, home_branch_id))';
  end if;
end $$;

-- ── 5. FORM B — a NULLABLE branch key, where NULL means "every branch" ──────────────────────────────
-- price_list and promotion (3A); catalogue_tombstone (6A — its item, tax_code and customer streams have no
-- branch at all, so a company-wide tombstone carries NULL and must stay visible to every terminal, or the
-- till never learns that an item was deleted). 8D's public_holiday takes this form in 0096.
-- NULL must be VISIBLE, not denied: app.actor_in_branch(company_id, null) is false for every
-- branch-restricted principal, so Form A here would hide the head-office price list and every company-wide
-- promotion from exactly the principals that need them.
create policy branch_isolation on app.price_list          as restrictive using (branch_id is null or app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.promotion           as restrictive using (branch_id is null or app.actor_in_branch(company_id, branch_id));
create policy branch_isolation on app.catalogue_tombstone as restrictive using (branch_id is null or app.actor_in_branch(company_id, branch_id));

-- ── 6. FORM C — stock, keyed by warehouse ───────────────────────────────────────────────────────────
-- None of these carries a branch column; warehouse.branch_id is the only branch key in the inventory model,
-- which is why test 36's stock clause cannot be met any other way. 3A and 3B created them branch-ready
-- (warehouse_id NOT NULL) and attached nothing.
create policy branch_isolation on app.inventory_movement  as restrictive using (app.actor_in_warehouse(company_id, warehouse_id));
create policy branch_isolation on app.stock_on_hand       as restrictive using (app.actor_in_warehouse(company_id, warehouse_id));
create policy branch_isolation on app.cost_layer          as restrictive using (app.actor_in_warehouse(company_id, warehouse_id));
create policy branch_isolation on app.stock_valuation     as restrictive using (app.actor_in_warehouse(company_id, warehouse_id));
-- cost_consumption has no warehouse_id; it reaches one through its movement.
create policy branch_isolation on app.cost_consumption as restrictive
  using (exists (select 1 from app.inventory_movement m where m.id = movement_id and app.actor_in_warehouse(m.company_id, m.warehouse_id)));

-- The aggregate-child guard separately binds parent visibility for direct reads and writes.
create policy document_parent_visibility on app.document_line as restrictive
  using (exists (select 1 from app.document d where d.tenant_id=document_line.tenant_id
    and d.company_id=document_line.company_id and d.id=document_line.document_id))
  with check (exists (select 1 from app.document d where d.tenant_id=document_line.tenant_id
    and d.company_id=document_line.company_id and d.id=document_line.document_id));

-- Minimal current-tenant projection for a credential whose employee home branch differs.
grant select (id,tenant_id,company_id,employee_number) on app.employee to app_auth;
grant select (principal_id,tenant_id,company_id,employee_id,branch_id,revoked_at) on app.pos_cashier to app_auth;
grant select (tenant_id,principal_id,role_id,company_id,expires_at) on app.role_assignment to app_auth;
grant select (tenant_id,principal_id,role_id,company_id,branch_id) on app.role_assignment_branch to app_auth;
create function app.resolve_cashier_employee(p_company_id uuid,p_branch_id uuid,p_principal_id uuid)
returns table(employee_id uuid,employee_number text)
language sql stable security definer set search_path = app, pg_temp as $$
  select e.id,e.employee_number from app.pos_cashier c
    join app.employee e on e.tenant_id=c.tenant_id and e.company_id=c.company_id and e.id=c.employee_id
   where c.tenant_id=app.current_tenant() and c.company_id=p_company_id and c.branch_id=p_branch_id
     and c.principal_id=p_principal_id and c.revoked_at is null
     and app.actor_in_branch(p_company_id,p_branch_id)
$$;
revoke all on function app.resolve_cashier_employee(uuid,uuid,uuid) from public;
grant execute on function app.resolve_cashier_employee(uuid,uuid,uuid) to app_rw;
grant create on schema app to app_auth;
alter function app.resolve_cashier_employee(uuid,uuid,uuid) owner to app_auth;
revoke create on schema app from app_auth;

create or replace function app.pos_cashier_sync(p_company_id uuid,p_branch_id uuid,p_since bigint)
returns table(id uuid,revision bigint,"row" jsonb) language sql stable as $$
  select c.principal_id,c.revision,(to_jsonb(c)-'tenant_id') || jsonb_build_object(
    'employee_number',e.employee_number,'revision',c.revision::text)
  from app.pos_cashier c
  join lateral app.resolve_cashier_employee(c.company_id,c.branch_id,c.principal_id) e on e.employee_id=c.employee_id
  where c.company_id=p_company_id and c.branch_id=p_branch_id and c.revision>p_since and c.revoked_at is null
$$;
