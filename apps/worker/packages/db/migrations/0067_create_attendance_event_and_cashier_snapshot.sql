
-- Only the tenant's system actor can report a keyed cashier projection fault; audit privileges stay closed.
create function app.record_cashier_snapshot_drift(p_principal_id uuid,p_before jsonb,p_after jsonb)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_seq bigint;
begin
  if not exists(select 1 from app.principal p join app.membership m on m.principal_id=p.id
    where p.id=app.current_actor() and p.kind='system' and m.tenant_id=app.current_tenant()) then
    raise exception 'ERR_RBAC_FORBIDDEN: cashier drift reporting requires the tenant system actor' using errcode='check_violation';
  end if;
  if not exists(select 1 from app.pos_cashier c where c.principal_id=p_principal_id and c.tenant_id=app.current_tenant()) then
    raise exception 'ERR_NOT_FOUND: cashier is not visible' using errcode='check_violation';
  end if;
  insert into app.audit_log(tenant_id,table_name,row_id,action,"before","after")
  values(app.current_tenant(),'cashier_snapshot_drift',p_principal_id::text,'update',p_before,p_after)
  returning seq into v_seq;
  return v_seq;
end $$;
revoke all on function app.record_cashier_snapshot_drift(uuid,jsonb,jsonb) from public;
grant execute on function app.record_cashier_snapshot_drift(uuid,jsonb,jsonb) to app_rw;
