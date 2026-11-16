-- 0102_create_import_batch.sql — contracts §4.6.1 and §4.13.3. The idempotence ledger of the Phase 9 load: one row
-- per legacy key per company, recording what that key became. Re-running a load reads this table and inserts nothing
-- twice (§5.1 #5's duplicate aggregate rows are why it cannot be a blind insert).
--
-- source_hash is round 20's C7: without it the natural key makes a second run either always a conflict or always a
-- no-op, and neither is idempotence. An identical re-read is a silent skip; a CHANGED source row for a key already
-- mapped is ERR_IMPORT_DUPLICATE_SOURCE_KEY, so the operator sees that the frozen source moved under them (§5.1 #10
-- "scope first, migrate second" assumes a freeze).

create table app.import_batch (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  source_table  text not null,                                    -- the legacy relation, upper case as Firebird stores it
  source_key    text not null,                                    -- the legacy row's own key, as a string (SAH-051)
  target_table  text not null,                                    -- the app.* table the row became
  target_id     uuid not null,                                    -- the Dulja row's id (polymorphic, so no FK)
  source_hash   text not null,                                    -- sha256 of the mapped payload (round 20 C7)
  run_id        uuid not null,                                    -- the load run that produced it
  loaded_by     uuid not null default app.current_actor() references app.principal(id),   -- stamped (spec:2179)
  created_at    timestamptz not null default now(),
  constraint import_batch_source_table_check check (source_table ~ '^[A-Z][A-Z0-9_$]{0,62}$'),
  constraint import_batch_target_table_check check (target_table ~ '^[a-z][a-z0-9_]{0,62}$'),
  constraint import_batch_source_key_check   check (length(source_key) between 1 and 512),
  constraint import_batch_source_hash_check  check (source_hash ~ '^[0-9a-f]{64}$'),   -- sha256, lower-case hex
  constraint import_batch_natural_key unique (company_id, source_table, source_key),   -- ERR_IMPORT_DUPLICATE_SOURCE_KEY
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

comment on table app.import_batch is
  'Contracts §4.13.3 — the Phase 9 idempotence ledger. One row per legacy key per company; the mapping from a legacy key to a Dulja id never moves once written (app_rw holds no UPDATE).';

-- §3.5.1 recipe items 2, 3, 4. import_batch joins no linter set (§3.5.3), so it keeps id, created_at and the audit
-- trigger like any ordinary table, and loaded_by gets its stamp.
call app_meta.enable_tenant_rls('app.import_batch');
call app_meta.attach_audit('app.import_batch');
call app_meta.attach_stamp('app.import_batch', 'loaded_by');

-- The two reads the loaders make: "what did this key become" (the natural key's index) and "how far has this run
-- got" (below), plus the reverse lookup a reconciliation makes from a Dulja row back to its legacy key. No
-- branch_isolation policy: import_batch has no branch key and is not one of §4.5.6's warehouse-keyed stock tables.
create index import_batch_run_idx    on app.import_batch (company_id, run_id, target_table);
create index import_batch_target_idx on app.import_batch (company_id, target_table, target_id);

-- app_rw receives select, insert and update through 0001's default privileges (plan0A:2564). The UPDATE goes: a
-- legacy key's mapping never moves, so it is enforced here rather than only by recordBatch (0021's document_event
-- precedent). NO delete either — §3.5.4's pinned list is complete for v1 and an import is undone by reversal
-- (spec:2049).
revoke update on app.import_batch from app_rw;
