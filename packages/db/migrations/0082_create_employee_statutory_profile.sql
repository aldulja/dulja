-- ── 0082_create_employee_statutory_profile.sql ─────────────────────────────────────────────────
-- §3.10.1 "Effective-dated statutory profile" (spec:2077). ⚠️ OD-28: the field list is verified
-- against LHDN's current publication and is NEVER invented here. This file ships exactly the three
-- fields spec:2077 itself names, plus residency_category (spec:2076 names it in the sensitive set;
-- the profile needs it UNENCRYPTED because it is a calculation input, not an identifier) and an
-- `extra jsonb` for the verified additions. When OD-28 lands, 8B's spare migration 0090 promotes
-- the confirmed members of `extra` to typed columns and backfills them. Nothing in 8A moves.

create table app.employee_statutory_profile (
  id                 uuid primary key default uuidv7(),
  tenant_id          uuid not null references app.tenant(id),
  employee_id        uuid not null,
  effective_from     date not null,
  effective_to       date,
  marital_status     text,
  spouse_working     boolean,
  child_relief_count int check (child_relief_count is null or child_relief_count >= 0),
  residency_category text,
  extra              jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),   -- ⚠️ OD-28 seam. NEVER a rate, a threshold or a formula.
  entered_by         uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at         timestamptz not null default now(),
  unique (employee_id, effective_from),
  unique (tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  foreign key (tenant_id, employee_id) references app.employee(tenant_id, id)
);

-- At most one OPEN row per employee: the history is the closed rows (spec:2077, ADR 0072).
create unique index employee_statutory_profile_open_idx
  on app.employee_statutory_profile (employee_id) where effective_to is null;

call app_meta.enable_tenant_rls('app.employee_statutory_profile');
call app_meta.attach_audit('app.employee_statutory_profile');
call app_meta.attach_stamp('app.employee_statutory_profile', 'entered_by');

-- The compensation gate, the same shape as spec:2076's sensitive_gate and for the same reason:
-- test 32 (spec:2450) requires "no employee_statutory_profile rows … by direct app_rw query under
-- withTenant" for a principal without hr.compensation.read, and a route check cannot satisfy that.
-- AS RESTRICTIVE so tenant_isolation cannot OR it away (SAH-033); no `with check`, so the same
-- predicate gates the write.
create policy compensation_gate on app.employee_statutory_profile as restrictive
  using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)));

-- R4 (spec:2175): nobody writes their own profile.
create trigger employee_statutory_profile_no_self_pay
  before insert or update on app.employee_statutory_profile
  for each row execute function app.forbid_self_pay('employee_id');

comment on column app.employee_statutory_profile.extra is
  '⚠️ OD-28. Verified additions to the LHDN input list, as {field: scalar}. A rate, threshold, ceiling or formula never appears here — those live in app.statutory_rate_table.definition (spec:2080).';
