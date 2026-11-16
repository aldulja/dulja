-- Restores 0010's audit_chain() and 0001's identity column. The identity's sequence is restarted past the
-- last drawn seq so the next insert cannot collide; no row is touched and no trigger is suspended. Rolling
-- this back reopens DBS-02 (concurrent writers in one tenant fork the chain) — ADR 0094.
create or replace function app.audit_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  select hash into prev from app.audit_log where tenant_id = new.tenant_id order by seq desc limit 1;
  new.prev_hash := prev;
  new.hash := sha256(coalesce(prev, ''::bytea) || convert_to(jsonb_build_array(new.tenant_id, new.actor_id, extract(epoch from new.occurred_at)::text, new.table_name, new.row_id, new.action, new.before, new.after)::text, 'UTF8'));
  return new;
end $$;

-- Restarted from the chain sequence's last value, not `max(seq)`: forced RLS hides every row from a migration. The
-- chain sequence is dropped before the identity is added, so `pg_get_serial_sequence` names only the identity's.
do $$
declare v_next bigint;
begin
  select case when is_called then last_value + 1 else last_value end into v_next from app.audit_log_chain_seq;
  drop sequence app.audit_log_chain_seq;
  alter table app.audit_log alter column seq add generated always as identity;
  perform setval(pg_get_serial_sequence('app.audit_log', 'seq'), v_next, false);
end $$;
