-- ── 0120 · app.record_system_event admits 'rate_table_lapse_warning' ───────────────────────────
-- 8A overrun, allocated from the §3.4.1 tail in the same change as this file (register row "8A overrun").
--
-- 8A Task 10's `hr.rate_table.lapse_warning` job records one audit row per run under the table_name sentinel
-- `rate_table_lapse_warning` (§4.2.6, contracts round 16 A10). The plan wrote a direct insert into app.audit_log,
-- which 0001 §8 refuses to app_rw; 0105's SECURITY DEFINER door is the only way in, and its list is closed. 8A's
-- own range (0080–0086) cannot carry the admission: every one of its numbers sorts BEFORE 0105, so on a fresh
-- database 0105 and 0111 would create or replace the function after it and drop the name again. Hence a tail
-- number, exactly as 0111 did for 3A's `lot_expiry_warning`.
--
-- The list stays closed. It gains one name, the grant is unchanged, and the door is otherwise 0105's.

create or replace function app.record_system_event(p_table text, p_row_id text, p_after jsonb)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_seq bigint;
begin
  if p_table not in ('integrity_incident', 'month_end_ready', 'lot_expiry_warning', 'rate_table_lapse_warning') then
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
