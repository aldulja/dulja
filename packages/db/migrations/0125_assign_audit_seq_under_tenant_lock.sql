-- ── 0125 · DBS-02 (2026-11-15 review) · ADR 0094 · the audit chain's position is assigned under the tenant lock ──
-- `app.audit_log.seq` was `generated always as identity` (0001 §8), so its number was drawn when the row was
-- formed, BEFORE `app.audit_chain()` took the `tenant-serial:` advisory lock and read its predecessor as
-- `order by seq desc limit 1`. A writer that waited on that lock therefore kept the number it drew before
-- waiting while linking to whatever committed during the wait: S1 writes seq 9, S2 draws seq 10 and blocks,
-- S1 writes seq 11 and commits, S2 writes seq 10 with prev = hash(11). Both verifiers walk
-- `lag(hash) over (order by seq)`, so two links read as broken on untampered data for ever (the log is
-- immutable), and the waiter's row has no successor in seq order, so deleting it went undetected.
--
-- The fix keeps `seq` as the one chain order every reader already uses (both verifiers, test 13, the audit
-- routes, `order by seq` across the tree) and moves the moment it is drawn: the identity is dropped and
-- `app.audit_chain()` draws `nextval` itself, after the lock and in the same critical section that reads the
-- predecessor. A later writer in the tenant can only take the lock after the holder commits or rolls back, so
-- within a tenant seq order is lock order is link order. Numbers stay globally unique (one sequence for all
-- tenants); a rolled-back writer still leaves a gap, which the verifiers have always ignored.
--
-- The preimage is unchanged — `seq` was never hashed — so every row written before this migration still verifies
-- and nothing is rehashed or rewritten: `audit_log_immutable` and every other trigger run throughout. Dropping
-- the identity touches no row. Migration 0010's forward-only window is still open (no deployed database holds
-- audit rows anyone must verify, OD-19/OD-20), so ADR 0094 records this as free today; an already-forked chain
-- in a test database is not repaired, only no longer produced.
--
-- The chain read relies on each statement seeing what committed before the lock was granted, which holds under
-- READ COMMITTED (a volatile plpgsql statement takes a fresh snapshot) and not under REPEATABLE READ or
-- SERIALIZABLE, where the transaction's first snapshot would hide the holder's rows and fork the chain the same
-- way. `withTenant` pins READ COMMITTED; the trigger now refuses the other levels rather than fork silently.

-- ── 1. seq is drawn by the trigger, not by the column ──────────────────────────────────────────────────────────
-- The new sequence continues exactly where the identity would have, read from the identity's own sequence row:
-- `audit_log` is under forced RLS and this file runs with no tenant context, so `max(seq)` would see no rows and
-- restart at 1; and `pg_sequence_last_value` is null after a `setval(…, false)`, as a down → up leaves it.
-- It is attached to the column only after the identity is gone, so `pg_get_serial_sequence` never has two to
-- choose between.
create sequence app.audit_log_chain_seq as bigint;
do $$
declare v_next bigint;
begin
  execute format('select case when is_called then last_value + 1 else last_value end from %s',
                 pg_get_serial_sequence('app.audit_log', 'seq')) into v_next;
  perform setval('app.audit_log_chain_seq', v_next, false);
end $$;
alter table app.audit_log alter column seq drop identity;
alter sequence app.audit_log_chain_seq owned by app.audit_log.seq;

-- ── 2. audit_chain(): lock, number, link — in that order ───────────────────────────────────────────────────────
-- The hash expression is 0010's, character for character (packages/db/src/audit/verify-chain.ts recomputes it).
-- `new.seq` is overwritten unconditionally, so an inserter cannot choose a position (only app_migrator and the
-- SECURITY DEFINER writers can insert at all; 0001 §9 revokes INSERT from app_rw).
create or replace function app.audit_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ERR_AUDIT_ISOLATION: an audited write must run under READ COMMITTED, not %', current_setting('transaction_isolation')
      using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  new.seq := nextval('app.audit_log_chain_seq');
  select hash into prev from app.audit_log where tenant_id = new.tenant_id order by seq desc limit 1;
  new.prev_hash := prev;
  new.hash := sha256(coalesce(prev, ''::bytea) || convert_to(jsonb_build_array(new.tenant_id, new.actor_id, extract(epoch from new.occurred_at)::text, new.table_name, new.row_id, new.action, new.before, new.after)::text, 'UTF8'));
  return new;
end $$;
