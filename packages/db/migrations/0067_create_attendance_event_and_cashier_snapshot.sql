-- 0067_create_attendance_event_and_cashier_snapshot.sql — minimal attendance (§4.6.1; spec:2089)
-- in sections 1-2, and the pos_cashier snapshot projection (§4.6.3; spec:1324) in sections 3-5 (Task 7).
-- "Attributed to the employee, with the terminal or principal as actor." Readable by HR and payroll as a
-- report; NEVER an automatic pay input in v1 — 8B computes nothing from these rows, and unpaid leave
-- reaches payroll as a quantity on a pay component instead (spec:2089, 2079).

create table app.attendance_event (
  id                uuid primary key default uuidv7(),
  tenant_id         uuid not null references app.tenant(id),
  company_id        uuid not null,
  employee_id       uuid not null,                                   -- ATTRIBUTION: whose attendance this is
  branch_id         uuid not null,                                   -- where; branch_isolation is attached by 0068 (Form A)
  kind              text not null,
  occurred_at       timestamptz not null,                            -- business time: the till clock or the corrected time
  terminal_id       uuid,                                            -- the till that recorded it, when it came from one
  recorded_by       uuid not null default app.current_actor() references app.principal(id),  -- ACTOR: stamped, never a payload value (LEGACY-044)
  note              text,
  corrects_event_id uuid,
  created_at        timestamptz not null default now(),
  constraint attendance_event_kind_check check (kind in ('clock_in', 'clock_out', 'manual_correction')),
  -- Only a manual_correction corrects anything, and only a manual_correction may carry the pointer.
  constraint attendance_event_correction_kind check (
    (corrects_event_id is null) or (kind = 'manual_correction')),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)        references app.company(tenant_id, id),
  foreign key (tenant_id, employee_id)       references app.employee(tenant_id, id),
  foreign key (tenant_id, branch_id)         references app.dimension_value(tenant_id, id),
  foreign key (tenant_id, terminal_id)       references app.pos_terminal(tenant_id, id),
  foreign key (tenant_id, corrects_event_id) references app.attendance_event(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.attendance_event');
call app_meta.attach_audit('app.attendance_event');
call app_meta.attach_stamp('app.attendance_event', 'recorded_by');

-- A correction that points at another employee's event would silently move hours between two people.
-- A composite FK cannot express it (the parent's employee_id is not part of any key), so it is a trigger.
create function app.assert_attendance_correction() returns trigger language plpgsql as $$
declare target_employee uuid;
begin
  if new.corrects_event_id is null then return new; end if;
  select employee_id into target_employee from app.attendance_event where id = new.corrects_event_id;
  if target_employee is null then
    raise exception 'ERR_NOT_FOUND: attendance event % is not visible', new.corrects_event_id using errcode = 'check_violation';
  end if;
  if target_employee <> new.employee_id then
    raise exception 'attendance_event_corrects_same_employee: event % belongs to employee %, not %',
      new.corrects_event_id, target_employee, new.employee_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger attendance_event_correction before insert on app.attendance_event
  for each row execute function app.assert_attendance_correction();

create index attendance_event_employee_idx on app.attendance_event (employee_id, occurred_at desc);
create index attendance_event_branch_idx on app.attendance_event (company_id, branch_id, occurred_at desc);

-- Sections 3-5 (the pos_cashier snapshot projection, its four triggers and app.who_can_reset_a_pin) are
-- appended by Task 7, in this same file and this same PR.

-- ── 3. the snapshot projection (§4.6.3; spec:1324; ADR 0061) ────────────────────────────────────────
-- The ONE writer of pos_cashier.snapshot. Which codes it holds is DERIVED from the catalogue, never
-- listed: a literal list would have to name 6D's pos.shift.close_any and pos.report.read before 6D seeds
-- them. pos.sync.* is excluded because it is the TERMINAL's authority (R8, spec:2179), never a cashier's.
-- A revoked cashier's code array is empty: the till must authorise nothing for them even before the next
-- catalogue pull removes the row (spec:2090, test 34).
-- **Two things this function deliberately does NOT write, and why.**
-- (1) `revision`. The UPDATE below fires 0065's `catalogue_revision` BEFORE trigger, which assigns
--     `new.revision := nextval(...)`. Any revision this function computed would therefore be one behind the
--     row the statement actually stores, `computeSnapshot` (which reads the row's CURRENT revision) would
--     disagree with the stored snapshot for EVERY cashier, and `findSnapshotDrift` would report the whole
--     table as drifted forever. Section 3a stamps the revision instead, after the trigger has assigned it.
-- (2) An untyped `0` or `0.05` fallback. `coalesce(b.max_void_amount, 0)::text` yields `'0'` for a branch
--     with no policy row — scale 0, because an untyped integer literal has scale 0 — while a real row yields
--     `'0.0000'`. Every fallback is therefore cast to its own column's type first, so a missing row and a
--     zeroed row produce byte-identical JSON and `limits.ts`'s TypeScript fallback can match them exactly.
-- **It reads and writes as the tenant's system principal, whoever fired it (PR 12 review; ADR 0061).**
-- `role` and `role_permission` belong to the whole tenant (an admin of company X alone edits a role through
-- the `{ company: "any" }` gate), while `pos_cashier` and `branch_pos_policy` carry Form A of
-- `branch_isolation`. Under the writer's own RLS a cashier of another company or branch was invisible, the
-- select below found nothing, and that cashier's snapshot silently kept the codes the edit had just changed.
-- So the function swaps `app.actor_id` to the system principal, which passes every form (0068), for its two
-- statements and puts the caller's value back before it returns. That grants nothing: the snapshot is DERIVED
-- from `principal_has` and the branch's policy row, so full visibility only lets it be computed correctly,
-- and `pos_cashier` has no audit trigger and no actor stamp for the system actor to appear in (0065).
-- RLS stays on; no SECURITY DEFINER, no BYPASSRLS. **No exception block, deliberately**: a caller can only
-- see an error raised in here from an enclosing savepoint or exception block, or after its transaction
-- aborts, and PostgreSQL reverts a transaction-local `set_config` made inside an aborted (sub)transaction —
-- so the restore below is needed on the normal path only, and the function has one exit so it cannot be
-- skipped. An exception block would add a subtransaction to every call, and `refresh_pos_cashier_for_role`
-- calls this once for every principal holding the edited role.
create function app.refresh_pos_cashier(p_principal_id uuid) returns void language plpgsql as $$
declare
  c        app.pos_cashier%rowtype;
  v_caller text := current_setting('app.actor_id', true);
  v_system uuid;
begin
  select p.id into v_system
    from app.principal p join app.membership m on m.principal_id = p.id
   where p.kind = 'system' and m.tenant_id = app.current_tenant();
  if v_system is null then
    raise exception 'ERR_TENANT_CONTEXT_MISSING: refreshing a cashier snapshot needs the tenant''s system principal'
      using errcode = 'check_violation';
  end if;
  perform set_config('app.actor_id', v_system::text, true);

  select * into c from app.pos_cashier where principal_id = p_principal_id;
  if c.principal_id is not null then                  -- else not a cashier: nothing to refresh
    update app.pos_cashier set
      snapshot = jsonb_build_object(
        'codes',
          case when c.revoked_at is not null then '[]'::jsonb
          else coalesce((
            select jsonb_agg(pm.code order by pm.code)
              from app.permission pm
             where pm.module = 'pos' and pm.code not like 'pos.sync.%'
               and app.principal_has(c.principal_id, pm.code, c.company_id, c.branch_id)
          ), '[]'::jsonb) end,
        'limits', (
          select jsonb_build_object(
                   'maxLineDiscountPct',   coalesce(b.max_line_discount_pct,   0::numeric(9,6))::text,
                   'maxTicketDiscountPct', coalesce(b.max_ticket_discount_pct, 0::numeric(9,6))::text,
                   'maxVoidAmount',        coalesce(b.max_void_amount,         0::numeric(19,4))::text,
                   'maxPriceOverridePct',  coalesce(b.max_price_override_pct,  0::numeric(9,6))::text,
                   'blindReturnAllowed',   coalesce(b.blind_return_allowed,    false),
                   'maxBlindReturnAmount', coalesce(b.max_blind_return_amount, 0::numeric(19,4))::text,
                   'roundingIncrement',    coalesce(b.rounding_increment,      0.05::numeric(19,4))::text,
                   'requireCustomerOver',  b.require_customer_over::text,
                   'maxCashInDrawer',      b.max_cash_in_drawer::text)
            from (select 1) one
            left join app.branch_pos_policy b on b.company_id = c.company_id and b.branch_id = c.branch_id)),
      snapshot_at = now()
    where principal_id = p_principal_id;
  end if;

  perform set_config('app.actor_id', coalesce(v_caller, ''), true);
end $$;

-- ── 3a. the revision stamp — the ONE writer of snapshot->'revision' ──────────────────────────────────
-- A bigint has no safe JS number form, so the value is a decimal STRING in the JSON and every reader takes
-- `snapshot->>'revision'` (§4.10.2). It is written by a BEFORE trigger rather than by refresh_pos_cashier
-- because `new.revision` is not known until 0065's `catalogue_revision` trigger has run.
--
-- ⚠️ **Trigger ORDER is load-bearing and is a name, not a declaration.** PostgreSQL fires triggers of the
-- same event in *name* order, and `catalogue_revision` < `snapshot_revision_stamp`, so the sequence value is
-- assigned first and stamped second. **Renaming either trigger silently inverts them** and puts a stale
-- revision back in the snapshot; Step 3's *"snapshot->>'revision' is the row's OWN revision"* case is what
-- would catch it, and the `computeSnapshot agrees with the stored row` case would go red for every cashier.
-- Stamping on EVERY insert or update — not only on a refresh — is deliberate: a PIN reset or a revocation
-- bumps the revision too, and a snapshot whose revision lagged its own row would tell a till it was current.
create function app.stamp_snapshot_revision() returns trigger language plpgsql as $$
begin
  new.snapshot := jsonb_set(coalesce(new.snapshot, '{}'::jsonb), '{revision}',
                            to_jsonb(new.revision::text), true);
  return new;
end $$;

create trigger snapshot_revision_stamp before insert or update on app.pos_cashier
  for each row execute function app.stamp_snapshot_revision();

-- ── 4. the four triggers that call it (spec:1324 names the first three; the fourth is the limit row) ──
create function app.refresh_pos_cashier_for_assignment() returns trigger language plpgsql as $$
begin
  if tg_op <> 'INSERT' then
    perform app.refresh_pos_cashier(old.principal_id);
  end if;
  if tg_op <> 'DELETE' and (tg_op = 'INSERT' or new.principal_id is distinct from old.principal_id) then
    perform app.refresh_pos_cashier(new.principal_id);
  end if;
  return null;
end $$;

create function app.refresh_pos_cashier_for_role() returns trigger language plpgsql as $$
declare r record;
begin
  for r in select distinct ra.principal_id from app.role_assignment ra
            where ra.role_id = new.role_id or ra.role_id = old.role_id loop
    perform app.refresh_pos_cashier(r.principal_id);
  end loop;
  return null;
end $$;

create function app.refresh_pos_cashier_for_branch_policy() returns trigger language plpgsql as $$
declare r record;
begin
  for r in select principal_id from app.pos_cashier
            where (company_id = new.company_id and branch_id = new.branch_id)
               or (company_id = old.company_id and branch_id = old.branch_id) loop
    perform app.refresh_pos_cashier(r.principal_id);
  end loop;
  return null;
end $$;

create trigger refresh_pos_cashier after insert or update or delete on app.role_assignment
  for each row execute function app.refresh_pos_cashier_for_assignment();
create trigger refresh_pos_cashier after insert or update or delete on app.role_assignment_branch
  for each row execute function app.refresh_pos_cashier_for_assignment();
create trigger refresh_pos_cashier after insert or update or delete on app.role_permission
  for each row execute function app.refresh_pos_cashier_for_role();
create trigger refresh_pos_cashier after insert or update on app.branch_pos_policy
  for each row execute function app.refresh_pos_cashier_for_branch_policy();

-- ── 5. one query answers "who can reset a PIN at branch B" (spec:2134, test 36) ─────────────────────
-- A view, not a function, so the answer is a relation an auditor can filter and join like any other.
-- `security_invoker = true` because from PostgreSQL 15 a view otherwise executes with its OWNER's
-- privileges, and the owner here is app_migrator, the schema owner. The three tables it reads carry
-- `tenant_isolation` with FORCE ROW LEVEL SECURITY so nothing would leak either way — but this view is the
-- one object in the slice whose RLS would not be evaluated as the reader, and "the auditor's own query"
-- is the whole claim spec:2134 makes. Step 3's *"evaluated as the READER"* case asserts a second tenant
-- reads zero rows through it.
create view app.who_can_reset_a_pin with (security_invoker = true) as
  select distinct ra.company_id, b.branch_id, ra.principal_id
    from app.role_assignment ra
    join app.role_permission rp on rp.role_id = ra.role_id and rp.permission_code = 'pos.cashier.manage_pin'
    left join app.role_assignment_branch b
           on b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
   where ra.expires_at is null or ra.expires_at > now();
comment on view app.who_can_reset_a_pin is
  'spec:2134 / test 36: a branch_id of NULL means company-wide (no role_assignment_branch rows), exactly as app.actor_has reads it.';
grant select on app.who_can_reset_a_pin to app_rw;

-- Only the tenant's system actor can report a keyed cashier projection fault; audit privileges stay closed.
create function app.record_cashier_snapshot_drift(p_principal_id uuid,p_before jsonb,p_after jsonb)
returns bigint language plpgsql security definer set search_path = app, pg_temp as $$
declare v_seq bigint;
begin
  if not exists(select 1 from app.principal p join app.membership m on m.principal_id=p.id
    where p.id=app.current_actor() and p.kind='system' and m.tenant_id=app.current_tenant()) then
    raise exception 'ERR_RBAC_FORBIDDEN: cashier drift reporting requires the tenant system actor' using errcode='check_violation';
  end if;
  if not exists(select 1 from app.pos_cashier c where c.principal_id=p_principal_id and c.tenant_id=app.current_tenant()) then
    raise exception 'ERR_NOT_FOUND: cashier is not visible' using errcode='check_violation';
  end if;
  insert into app.audit_log(tenant_id,table_name,row_id,action,"before","after")
  values(app.current_tenant(),'cashier_snapshot_drift',p_principal_id::text,'update',p_before,p_after)
  returning seq into v_seq;
  return v_seq;
end $$;
revoke all on function app.record_cashier_snapshot_drift(uuid,jsonb,jsonb) from public;
grant execute on function app.record_cashier_snapshot_drift(uuid,jsonb,jsonb) to app_rw;
