-- ── 0096_create_leave_register.sql — ⚠️ OD-13, answered BUILD on 2026-11-07 ─────────────────────────────────
-- spec:2085's minimal register: leave_type (annual, sick, unpaid, other), a yearly leave_entitlement ENTERED by HR
-- (no accrual engine), leave_record approved by a principal other than the employee (R4, spec:2175; test 31), and
-- public holidays per company and branch. It is a RECORD, never a pay input: unpaid leave reaches payroll as a
-- QUANTITY on 8B's unpaid-leave deduction component (spec:2085's first sentence), with or without this register.
--
-- This file also inserts the two hr.leave.* permission rows (contracts round 19, 8D A9): the whole OD-13 gate is one
-- file, one permissions.ts hunk and one task. app.permission is GLOBAL and has no RLS, so it is the one table a
-- migration may write (§3.4.8); the role grants are packages/db/seed/roles.ts, applied by `bun run seed --only roles`.
--
-- Isolation (8D A8): public_holiday carries §4.5.6 Form B (a NULL branch is every branch). leave_type has no branch
-- key. leave_entitlement and leave_record have no branch key either — they are isolated THROUGH the employee, as
-- document_line is through document (0068's document_parent_visibility): a RESTRICTIVE employee_parent_visibility
-- policy admits a row only while its employee, of the row's own company, is visible to the actor. That is also what
-- keeps R4 whole: app.forbid_self_pay() reads the employee under the actor's RLS, so an approver who cannot see the
-- employee (another branch) cannot see the record either, and can never reach the "invisible employee" bypass.

-- ── 1. leave_type — the vocabulary, per company (spec:2085) ─────────────────────────────────────────────────
create table app.leave_type (
  id            uuid primary key default uuidv7(),
  tenant_id     uuid not null references app.tenant(id),
  company_id    uuid not null,
  code          text not null check (code in ('annual', 'sick', 'unpaid', 'other')),
  name_en       text not null,
  name_ar       text,
  paid          boolean not null default true,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (company_id, code),
  unique (tenant_id, id),
  -- The target of the two children's company-bound FK: a leave type of one company can never be named by another
  -- company's entitlement or record (RLS bounds the tenant only).
  unique (tenant_id, company_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.leave_type');
call app_meta.attach_audit('app.leave_type');

-- ── 2. leave_entitlement — a yearly figure ENTERED by HR; there is no accrual engine ─────────────────────────
create table app.leave_entitlement (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  employee_id    uuid not null,
  year           smallint not null check (year between 2000 and 2200),
  leave_type_id  uuid not null,
  days           numeric(6,2) not null check (days >= 0),
  entered_by     uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at     timestamptz not null default now(),
  unique (employee_id, year, leave_type_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)                references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id)               references app.employee(tenant_id, id),
  foreign key (tenant_id, company_id, leave_type_id) references app.leave_type(tenant_id, company_id, id)
);
call app_meta.enable_tenant_rls('app.leave_entitlement');
call app_meta.attach_audit('app.leave_entitlement');
call app_meta.attach_stamp('app.leave_entitlement', 'entered_by');

create policy employee_parent_visibility on app.leave_entitlement as restrictive
  using (exists (select 1 from app.employee e where e.tenant_id = leave_entitlement.tenant_id
    and e.company_id = leave_entitlement.company_id and e.id = leave_entitlement.employee_id));

-- ── 3. leave_record — decided by a principal other than the employee (R4, spec:2175; test 31) ───────────────
create table app.leave_record (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  employee_id    uuid not null,
  leave_type_id  uuid not null,
  starts_on      date not null,
  ends_on        date not null,
  days           numeric(6,2) not null check (days > 0),
  status         text not null default 'requested' check (status in ('requested', 'approved', 'rejected')),
  -- NULL while `requested`; app.stamp_actor stamps the NULL → value transition with the SESSION actor and raises
  -- ERR_ACTOR_IMMUTABLE on any later change. A supplied value is never trusted (SAH-044). The column names the
  -- principal who DECIDED the record — an approval or a rejection alike.
  approved_by    uuid references app.principal(id),
  reason         text,
  created_at     timestamptz not null default now(),
  check (ends_on >= starts_on),
  -- A record cannot claim more days than its calendar span (half days are allowed: numeric(6,2)).
  check (days <= (ends_on - starts_on + 1)),
  -- requested ⇔ undecided. Stronger than "decided ⇒ named": a decider stamped onto a still-requested row would
  -- otherwise survive the later approval by someone else (stamp_actor keeps a non-null value), misattributing it.
  check ((status = 'requested') = (approved_by is null)),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)                references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id)               references app.employee(tenant_id, id),
  foreign key (tenant_id, company_id, leave_type_id) references app.leave_type(tenant_id, company_id, id)
);
call app_meta.enable_tenant_rls('app.leave_record');
call app_meta.attach_audit('app.leave_record');
call app_meta.attach_stamp('app.leave_record', 'approved_by');

create policy employee_parent_visibility on app.leave_record as restrictive
  using (exists (select 1 from app.employee e where e.tenant_id = leave_record.tenant_id
    and e.company_id = leave_record.company_id and e.id = leave_record.employee_id));

-- R4 (spec:2175): "… and leave_record.status = approved where the target employee's principal_id =
-- app.current_actor() are rejected by trigger". 8A's app.forbid_self_pay() (0080) is the ONE implementation; its
-- argument names the employee-id column. A rejection is deliberately outside it: spec:2175 forbids APPROVING one's
-- own leave, and refusing a self-withdrawal would leave a self-requested record with no way to close it.
create trigger leave_record_no_self_approve
  before insert or update of status, approved_by on app.leave_record
  for each row when (new.status = 'approved')
  execute function app.forbid_self_pay('employee_id');

-- A record is INSERTED requested and DECIDED by updating its own row, once. Without this a decided record could be
-- flipped (rejected → approved by a third principal, keeping the first decider's stamp) or re-dated after approval.
-- The allocation precedent (0046): ERR_TABLE_IMMUTABLE, SQLSTATE 23514, so the API answers 409.
create function app.guard_leave_record() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' or new.approved_by is not null then
      raise exception 'ERR_TABLE_IMMUTABLE: a leave record is inserted requested; it is decided by updating its own row'
        using errcode = 'check_violation';
    end if;
  elsif old.status <> 'requested' then
    raise exception 'ERR_TABLE_IMMUTABLE: leave record % is already %; a decision is final — request the leave again',
      old.id, old.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger leave_record_decision_final
  before insert or update on app.leave_record
  for each row execute function app.guard_leave_record();

create index leave_record_employee_period_idx on app.leave_record (company_id, employee_id, starts_on);

-- ── 4. public_holiday — per company AND branch; a NULL branch means every branch ───────────────────────────
create table app.public_holiday (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  branch_id    uuid,                                   -- NULL = company-wide (spec:2085)
  holiday_on   date not null,
  name_en      text not null,
  name_ar      text,
  created_at   timestamptz not null default now(),
  -- `nulls not distinct` is load-bearing: PostgreSQL treats NULLs as DISTINCT in a unique constraint by default, so a
  -- plain unique would accept TWO company-wide holidays on one date — exactly the duplicate this exists to refuse.
  unique nulls not distinct (company_id, branch_id, holiday_on),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, branch_id)  references app.dimension_value(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.public_holiday');
call app_meta.attach_audit('app.public_holiday');

-- §4.5.6 Form B for a NULLABLE branch key (8D A8): NULL is every branch, so the policy must admit it or a
-- company-wide holiday would be invisible to everyone. 6C's actor_in_branch (0068) is in the tree on this branch.
create policy branch_isolation on app.public_holiday as restrictive
  using (branch_id is null or app.actor_in_branch(company_id, branch_id));

-- ── 5. the two ⚠️ permission codes (8D A9) ───────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('hr.leave.record',  'hr', true, 'Record a leave request, an entitlement, a leave type or a public holiday'),
  ('hr.leave.approve', 'hr', true, 'Approve or reject a leave record for someone other than oneself')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;
