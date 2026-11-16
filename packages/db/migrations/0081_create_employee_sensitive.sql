-- ── 0081_create_employee_sensitive.sql ─────────────────────────────────────────────────────────
-- §3.10.1 "Sensitive data" (spec:2076) and §4.12.5. Nine ciphertext columns under one key version,
-- keyed on employee_id (NO_ID_TABLES, §3.5.3) because there is exactly one row per employee.
-- The table deliberately carries NO company_id: the gate joins app.employee for it (spec:2076).

create table app.employee_sensitive (
  employee_id            uuid primary key,
  tenant_id              uuid not null references app.tenant(id),
  national_id_enc        bytea,
  passport_enc           bytea,
  date_of_birth_enc      bytea,
  residency_category_enc bytea,
  bank_account_enc       bytea,
  epf_number_enc         bytea,
  socso_number_enc       bytea,
  tax_number_enc         bytea,
  work_permit_expiry_enc bytea,
  key_version            smallint not null check (key_version > 0),
  updated_by             uuid not null default app.current_actor() references app.principal(id),   -- stamped (A19)
  updated_at             timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  unique (tenant_id, employee_id),                            -- the NO_ID_TABLES form of unique (tenant_id, id)
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);

call app_meta.enable_tenant_rls('app.employee_sensitive');
-- No space after the comma: app.audit_row() splits key_cols on ',' and reads `rec ->> k` per element.
call app_meta.attach_audit('app.employee_sensitive', 'tenant_column', 'employee_id');

-- ── updated_by: an ALWAYS stamp, deliberately NOT app_meta.attach_stamp (8A amendment A19) ─────
-- 0A's app.stamp_actor() is a WRITE-ONCE stamp: on UPDATE it fills a NULL and raises
-- ERR_ACTOR_IMMUTABLE on any change to a non-null value. That is right for entered_by / loaded_by /
-- verified_by, which record one event each. It is WRONG here: this row is edited -- a bank account
-- changes, and writeSensitive() is an upsert -- so a write-once stamp would pin updated_by to the
-- CREATOR for the life of the row while updated_at moved, a column naming the wrong principal
-- (LEGACY-044). The trigger below stamps the session's actor on every INSERT and every UPDATE; the
-- value never comes from the caller, which is all §3.3 requires. The column name arrives in
-- TG_ARGV, a literal written in this file, and the row is rebuilt with jsonb_populate_record rather
-- than format(), so no identifier is ever assembled from text.
create function app.stamp_actor_always() returns trigger language plpgsql as $$
declare col text := tg_argv[0];
begin
  return jsonb_populate_record(new, jsonb_build_object(col, app.current_actor()));
end $$;
-- The trigger keeps the name attach_stamp would have given it, so 0A's stamp_actor linter rule (a
-- *_by column needs a trigger NAMED stamp_<col>) is satisfied unchanged. BEFORE triggers fire in
-- NAME order, so `employee_sensitive_no_self_pay` runs first and R4 refuses a self-write before
-- anything is stamped ('e' < 's'). Do not rename either trigger without checking that order again.
create trigger stamp_updated_by
  before insert or update on app.employee_sensitive
  for each row execute function app.stamp_actor_always('updated_by');

-- ── The gate, spec:2076 VERBATIM ────────────────────────────────────────────────────────────────
-- AS RESTRICTIVE because permissive policies OR together and a permissive gate would be voided by
-- tenant_isolation (LEGACY-033). No `with check`: PostgreSQL then uses `using` for the write check too,
-- so one predicate gates read AND write. app.actor_has returns true for the system principal, so
-- 8C's schedules and 8D's key rotation still run (spec:2076).
create policy sensitive_gate on app.employee_sensitive as restrictive
  using (app.actor_has('hr.employee.read_sensitive', (select e.company_id from app.employee e where e.id = employee_id)));

-- ── R4 (spec:2175) ──────────────────────────────────────────────────────────────────────────────
create trigger employee_sensitive_no_self_pay
  before insert or update on app.employee_sensitive
  for each row execute function app.forbid_self_pay('employee_id');

-- updated_at is maintained by the writer, not a trigger: writeSensitive() sets it in the same
-- statement as the ciphertext, and app_rw holds UPDATE here (the row is mutable by design). No DELETE
-- grant: spec:2049 admits none, and 8D's erasure workflow is a separate, audited path.
comment on table app.employee_sensitive is
  '§3.10.1 spec:2076. Every *_enc column is version(1)||nonce(12)||ciphertext||tag(16), AES-256-GCM, AAD = employee_id:column. Sealed and opened ONLY by packages/db/src/hr/sensitive.ts (ADR 0071).';
