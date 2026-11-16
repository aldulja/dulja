-- ── 0105 · app.record_system_event — the system's own evidence rows, inside the audit chain ─────────
-- Review remediation (Phase 2 review pass, PR #5); number allocated from the §3.4.1 tail, which is where a
-- branch that is not a slice takes one. Depends on 0001 alone.
--
-- 1B's `recordIntegrityIncident` and `recordMonthEndReady` insert straight into app.audit_log as app_rw —
-- and 0001 §8 REVOKES insert on app.audit_log from app_rw (0001:543; `privileges.test.ts` pins SELECT alone;
-- `audit.test.ts` pins that a standalone app_rw insert is refused). Their comments claimed the opposite. So
-- the nightly integrity job raised SQLSTATE 42501 before it ever reached the Sentry alarm, and month-end
-- wrote no readiness row for any company. The grant is NOT widened: 0010's chain canonicalisation relies on
-- application code being unable to write audit_log directly. Instead the two system events go through this
-- narrow SECURITY DEFINER door, owned by app_migrator (nobypassrls — FORCE RLS still binds it), which admits
-- exactly two table_name values, takes the tenant from the session and never from a parameter, and lets
-- app.audit_chain() hash and link the row like any other.
create function app.record_system_event(p_table text, p_row_id text, p_after jsonb)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_seq bigint;
begin
  if p_table not in ('integrity_incident', 'month_end_ready') then
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
revoke all on function app.record_system_event(text, text, jsonb) from public;
grant execute on function app.record_system_event(text, text, jsonb) to app_rw;
