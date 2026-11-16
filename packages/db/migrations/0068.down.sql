create or replace function app.pos_cashier_sync(p_company_id uuid, p_branch_id uuid, p_since bigint)
returns table (id uuid, revision bigint, "row" jsonb)
language sql stable as $$
  select c.principal_id, c.revision, (to_jsonb(c) - 'tenant_id') || jsonb_build_object(
    'employee_number', e.employee_number, 'revision', c.revision::text)
    from app.pos_cashier c
    join app.employee e on e.tenant_id = c.tenant_id and e.company_id = c.company_id and e.id = c.employee_id
   where c.company_id = p_company_id
     and c.branch_id = p_branch_id
     and c.revision > p_since
     and c.revoked_at is null
$$;

drop function app.resolve_cashier_employee(uuid,uuid,uuid);
revoke select (id,tenant_id,company_id,employee_number) on app.employee from app_auth;
revoke select (principal_id,tenant_id,company_id,employee_id,branch_id,revoked_at) on app.pos_cashier from app_auth;
revoke select (tenant_id,principal_id,role_id,company_id,expires_at) on app.role_assignment from app_auth;
revoke select (tenant_id,principal_id,role_id,company_id,branch_id) on app.role_assignment_branch from app_auth;
drop policy document_parent_visibility on app.document_line;
-- Reverse dependency order: the policies first (they call the functions), then the functions.
drop policy if exists branch_isolation on app.cost_consumption;
drop policy if exists branch_isolation on app.stock_valuation;
drop policy if exists branch_isolation on app.cost_layer;
drop policy if exists branch_isolation on app.stock_on_hand;
drop policy if exists branch_isolation on app.inventory_movement;
drop policy if exists branch_isolation on app.catalogue_tombstone;
drop policy if exists branch_isolation on app.promotion;
drop policy if exists branch_isolation on app.price_list;
drop policy if exists branch_isolation on app.employee;
drop policy if exists branch_isolation on app.warehouse;
drop policy if exists branch_isolation on app.needs_attention;
drop policy if exists branch_isolation on app.terminal_enrolment;
drop policy if exists branch_isolation on app.attendance_event;
drop policy if exists branch_isolation on app.branch_pos_policy;
drop policy if exists branch_isolation on app.pos_cashier;
drop policy if exists branch_isolation on app.pos_terminal;
drop policy if exists branch_isolation on app.document;
drop function if exists app.actor_in_warehouse(uuid, uuid);
drop function if exists app.actor_in_branch(uuid, uuid);
