-- Restores 0111's three-name list. Down-migrating this makes the rate-table lapse job fail on its first warning;
-- the grant and the SECURITY DEFINER shape are untouched either way.
create or replace function app.record_system_event(p_table text, p_row_id text, p_after jsonb)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_seq bigint;
begin
  if p_table not in ('integrity_incident', 'month_end_ready', 'lot_expiry_warning') then
    raise exception 'ERR_VALIDATION_FAILED: % is not a system event the audit log records', p_table
      using errcode = 'check_violation';
  end if;
  if app.current_tenant() is null or app.current_actor() is null then
    raise exception 'ERR_TENANT_CONTEXT_MISSING: a system event needs a tenant session' using errcode = 'check_violation';
  end if;
  insert into app.audit_log (tenant_id, table_name, row_id, action, after)
  values (app.current_tenant(), p_table, p_row_id, 'insert', p_after)
  returning seq into v_seq;
  return v_seq;
end $$;
