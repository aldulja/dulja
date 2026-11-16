-- 0010.down.sql — 0001's function body returned character for character, so that `create or replace` in either
-- direction leaves `pg_proc.prosrc` byte-identical and the up → down → up comparison sees no drift. The block
-- below is a literal copy of 0001_foundations.sql lines 482-490, differing only in `or replace`; it is not
-- paraphrased, and packages/db/test/audit.test.ts checks that claim against the file rather than trusting it.
--
-- Rolling back does not un-write history: rows hashed while 0010 was applied stop verifying the moment the old
-- formula is back, for the mirror image of the reason 0010's own header gives. That is the price of a hash
-- change either way, and it is payable only while no deployed database holds audit rows.
create or replace function app.audit_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  select hash into prev from app.audit_log where tenant_id = new.tenant_id order by seq desc limit 1;
  new.prev_hash := prev;
  new.hash := sha256(coalesce(prev, ''::bytea) || convert_to(new.tenant_id::text || '|' || new.actor_id::text || '|' || extract(epoch from new.occurred_at)::text || '|' || new.table_name || '|' || new.row_id || '|' || new.action || '|' || coalesce(new.before::text, '') || '|' || coalesce(new.after::text, ''), 'UTF8'));
  return new;
end $$;
