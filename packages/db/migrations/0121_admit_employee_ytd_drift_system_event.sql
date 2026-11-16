-- ── 0121 · app.record_system_event admits 'employee_ytd_drift' ──────────────────────────────────
-- 8C overrun, allocated from the §3.4.1 tail in the same change as this file (register row "8C overrun, Task 9").
--
-- 8C Task 9's nightly `hr.employee_ytd.rebuild` REPORTS drift and never repairs it (spec:2084, D14), writing one audit
-- row per drifted run under the table_name sentinel `employee_ytd_drift` (§4.2.6, contracts round 18 B2). The plan
-- wrote a direct insert into app.audit_log, which 0001 §8 refuses to app_rw; 0105's SECURITY DEFINER door is the only
-- way in, and its list is closed. 8C's own range (0091–0095) cannot carry the admission: every one of its numbers sorts
-- BEFORE 0105, so on a fresh database 0105, 0111 and 0120 would create or replace the function after it and drop the
-- name again. Hence a tail number, exactly as 0111 did for 3A's `lot_expiry_warning` and 0120 for 8A's
-- `rate_table_lapse_warning`.
--
-- The list stays closed. It gains one name, the grant is unchanged, and the door is otherwise 0105's.

create or replace function app.record_system_event(p_table text, p_row_id text, p_after jsonb)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_seq bigint;
begin
  if p_table not in ('integrity_incident', 'month_end_ready', 'lot_expiry_warning', 'rate_table_lapse_warning',
                     'employee_ytd_drift') then
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
