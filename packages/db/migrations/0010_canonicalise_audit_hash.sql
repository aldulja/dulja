-- `app.audit_chain()` as 0001 wrote it joins eight fields with a bare `|` and hashes the result, and nothing
-- escapes the separator. The map from record to preimage is therefore not injective: `table_name = 'company|x'`
-- with `row_id = 'y'`, and `table_name = 'company'` with `row_id = 'x|y'`, produce identical bytes and so an
-- identical hash. `row_id` is where `app.audit_row` puts user text — it is `string_agg` over the key columns, and
-- `document_series` keys on `series`, `role_permission` on `permission_code` — so a separator inside a field is a
-- thing the application writes, not a contrivance. What keeps the collision out of reach today is
-- `revoke insert on app.audit_log from app_rw` (0001 section 9), which is a grant, not a property of the hash;
-- two distinguishable histories that hash alike is the one thing a tamper-evident structure may not permit,
-- whatever the grants happen to say this week.
--
-- `jsonb_build_array` is the instrument because the escaping is already in the database and the old preimage
-- already leaned on it: `before` and `after` reached it through `::text`, so jsonb's deterministic rendering was
-- load-bearing before this migration and this adds no new dependency. Every string becomes a JSON string, so a
-- `|` inside a value can no longer pass for a boundary; `before` and `after` nest as structure instead of being
-- flattened into the same flat text as their neighbours; and SQL NULL becomes JSON `null`, which the old
-- `coalesce(…, '')` could not tell from an empty field. One collision does survive — a SQL NULL and a stored
-- jsonb `'null'` both render as `null` — and it stays unreachable for the same reason the old one did:
-- `app.audit_row` writes either NULL or a whole row object, and only app_migrator can insert anything else.
-- Length prefixes would close the hole too and were rejected: a hand-rolled framing whose
-- byte-length-versus-character-length rule would live only in a comment, against one PostgreSQL already
-- maintains and already round-trips.
--
-- `occurred_at` stays an epoch string rather than becoming a JSON timestamp, and that is the cast worth paying
-- for: `to_jsonb(timestamptz)` renders in the session's TimeZone, so one instant is "2026-01-15T00:00:00+00:00"
-- to one connection and "2026-01-15T08:00:00+08:00" to another, and a verifier that happened to connect with a
-- different TimeZone would report every row in the tenant as tampered. provision/roles.sql pins UTC on both
-- roles, but that is a setting someone can change, not an invariant; `extract(epoch …)` has no such setting. The
-- `::text` on top of it keeps the third field the exact text 0001 hashed, now quoted, and keeps it out of jsonb's
-- numeric rendering, which would otherwise make that field a JSON number for a finite timestamp and a JSON
-- string for a non-finite one.
--
-- This migration is forward-only: rows written before it do not verify under the new function. Rehashing them
-- means UPDATE on `app.audit_log`, and `audit_log_immutable` exists precisely to refuse that — AGENTS.md forbids
-- suspending an invariant even for a migration, and rewriting stored hashes is indistinguishable from the
-- tampering the chain is built to expose. That is free today and only today, the same trade 0008 took for
-- `account.currency`: nothing is deployed, OWNER GATES OD-19 and OD-20 are still open, and every database that
-- exists anywhere is built from this directory, so there is no pre-0010 audit row that anyone will ever verify.
-- After a production database exists this route is closed, and the same change would have to carry its own
-- version instead — a `hash_version` column, or a recorded `seq` cutover — with verify-chain.ts recomputing each
-- row under the formula that was in force when that row was written.
--
-- packages/db/src/audit/verify-chain.ts recomputes this expression and has to move with it, field for field and
-- in this order; one divergence and the nightly walk reports every row as a bad hash.
-- packages/db/test/audit.test.ts holds the two together by running the shipped verifier over rows this trigger
-- wrote. `create or replace` rather than a drop: the trigger keeps running throughout, which is what lets this be
-- a migration and not a gap in the chain.
create or replace function app.audit_chain() returns trigger language plpgsql as $$
declare prev bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('tenant-serial:' || new.tenant_id::text, 0));
  select hash into prev from app.audit_log where tenant_id = new.tenant_id order by seq desc limit 1;
  new.prev_hash := prev;
  new.hash := sha256(coalesce(prev, ''::bytea) || convert_to(jsonb_build_array(new.tenant_id, new.actor_id, extract(epoch from new.occurred_at)::text, new.table_name, new.row_id, new.action, new.before, new.after)::text, 'UTF8'));
  return new;
end $$;
