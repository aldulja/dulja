-- ── 0108 · an assignment names a MEMBER of the tenant, and the schema says so ─────────────────────────
-- Review remediation (Phase 2 review pass, PR #5); §3.4.1 tail number. Depends on 0001.
--
-- role_assignment.principal_id and pos_terminal.principal_id were plain foreign keys to the GLOBAL
-- app.principal, the one table with no tenant column, so "an FK cannot cross tenants" was not held for them.
-- And app.assert_assignment_kind() read the principal's kind through principal_in_tenant: for a principal of
-- another tenant the SELECT returned nothing, v_kind was NULL, both comparisons were NULL and the row was
-- accepted. Membership's primary key is (tenant_id, principal_id), which is exactly the pair to bind to.
alter table app.role_assignment add constraint role_assignment_membership_fk
  foreign key (tenant_id, principal_id) references app.membership(tenant_id, principal_id);
alter table app.pos_terminal add constraint pos_terminal_membership_fk
  foreign key (tenant_id, principal_id) references app.membership(tenant_id, principal_id);

create or replace function app.assert_assignment_kind() returns trigger language plpgsql as $$
declare v_kind app.principal_kind; v_code text;
begin
  select kind into v_kind from app.principal where id = new.principal_id;
  select code into v_code from app.role where id = new.role_id;
  if v_kind is null then
    raise exception 'ERR_RBAC_KIND: principal % is not a member of this tenant', new.principal_id using errcode = 'check_violation';
  elsif v_kind = 'system' then
    raise exception 'ERR_RBAC_KIND: the system principal holds no role' using errcode = 'check_violation';
  elsif (v_kind = 'terminal') <> (v_code = 'pos_terminal') then
    raise exception 'ERR_RBAC_KIND: role % cannot be assigned to a principal of kind %', v_code, v_kind using errcode = 'check_violation';
  end if;
  return new;
end $$;
