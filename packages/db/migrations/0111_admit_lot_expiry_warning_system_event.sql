-- ── 0111 · app.record_system_event admits 'lot_expiry_warning' ─────────────────────────────────
-- Phase 3 review pass, PR #6; allocated from the §3.4.1 tail (register row 0109–0112).
--
-- 3A Task 10's near-expiry job (`recordExpiryWarning`, packages/db/src/inventory/expiry.ts) records one
-- audit row per company per run under the table_name sentinel `lot_expiry_warning` — the third sentinel
-- after 1B's `integrity_incident` and `month_end_ready`, registered in the 3A plan's header as a §4.2.6
-- addition. It writes through 0105's `app.record_system_event`, which is the ONLY door app_rw has into
-- app.audit_log — and 0105 admits exactly the first two. So the job raised ERR_VALIDATION_FAILED whenever it
-- had anything to report, the per-company transaction rolled back, and no warning was ever written for
-- precisely the tenants the alert exists for. Nothing red said so: the handler suite is Testcontainer-backed.
--
-- The list stays closed. It gains one name, the grant is unchanged, and the door is otherwise 0105's.

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
