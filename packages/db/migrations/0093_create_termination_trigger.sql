-- 0093_create_termination_trigger.sql — 8C Task 10 (ADR 0078, a proposal; contracts §4.6.1's employee row).
-- spec:2090, verbatim: "setting `terminated_on` excludes the employee from later regular runs and, by trigger (an
-- AFTER UPDATE OF `terminated_on` trigger on `employee`, so a direct `app_rw` update or the Phase 9 importer cannot
-- bypass it), sets `pos_cashier.revoked_at`, expires every `role_assignment` of `employee.principal_id` and bumps the
-- catalogue revision (tombstone); it runs under the terminating actor, so R4 and `forbid_self_grant` still hold and
-- `hr_payroll` needs no `admin.role.assign`."
--
-- What this file deliberately does NOT do, because a slice that already shipped does it:
--   * it writes no catalogue tombstone — 6C's `pos_cashier_tombstone` fires on the null -> value transition of
--     `revoked_at`, which is exactly the revocation below (0065 section 3), and 6A's `catalogue_revision` bumps the row;
--   * it computes no snapshot — 6C's `refresh_pos_cashier` trigger on `role_assignment` (0067 section 4) recomputes the
--     cashier's snapshot as each assignment expires, which is how "and by 8C's termination trigger" reaches it;
--   * it does not check R4 — 8A's `employee_no_self_pay` BEFORE trigger on the same column raises ERR_HR_SELF_PAY, and
--     a BEFORE trigger runs first, so this AFTER trigger only ever sees a termination R4 admitted.
--
-- ORDER, and why: the assignments expire FIRST (under the terminating actor), so 6C's refresh empties every code in the
-- snapshot; the credential is revoked LAST, so the revocation is the row's final write and the tombstone 6C writes
-- carries the row's final revision — a till resuming from that revision receives the tombstone and nothing after it.
--
-- WHO each write runs as:
--   * `role_assignment` — the TERMINATING ACTOR. SECURITY INVOKER (the default) is the point: RLS, forbid_self_grant
--     and keep_last_admin_assignment all apply, so terminating the tenant's last administrator raises
--     ERR_RBAC_LAST_ADMIN and the whole transaction rolls back (appoint a successor first). The table carries tenant
--     RLS only, so the actor sees every assignment of the person.
--   * `pos_cashier` — the TENANT'S SYSTEM PRINCIPAL, for the two statements that find and revoke the credentials, and
--     the caller's actor is restored straight after (ADR 0061's `refresh_pos_cashier` precedent, 0067 section 3).
--     `pos_cashier` carries Form A of `branch_isolation` keyed on the CREDENTIAL's branch, which may differ from the
--     employee's home branch (0068 says so); under a branch-restricted actor's own RLS the revoke would match nothing
--     and leave a live till credential for a terminated employee — the door spec:2090 says the trigger closes. This
--     grants nothing: `pos_cashier` has no audit trigger and no actor stamp (AUDIT_EXEMPT, 0065), the only value
--     written is `now()`, and the rows are exactly the terminated employee's. No SECURITY DEFINER, no BYPASSRLS, no
--     exception block (a set_config inside an aborted transaction is reverted with it, so the restore is needed on the
--     normal path only, and the function has one exit).
--
-- Whose role assignments expire: `employee.principal_id`'s (spec:2090) AND each live credential's own principal —
-- a `pos_cashier` is keyed on the staff member's human principal (spec:2097), and a credential whose principal is
-- not the employee's login (the state 0094's constraint will refuse from 8C Task 11 on) must not keep pos codes either.
create function app.terminate_employee() returns trigger language plpgsql as $$
declare
  v_caller     text := current_setting('app.actor_id', true);
  v_system     uuid;
  v_cashiers   uuid[];
begin
  select p.id into v_system
    from app.principal p join app.membership m on m.principal_id = p.id
   where p.kind = 'system' and m.tenant_id = app.current_tenant();
  if v_system is null then
    raise exception 'ERR_TENANT_CONTEXT_MISSING: terminating an employee needs the tenant''s system principal'
      using errcode = 'check_violation';
  end if;

  -- 1. the employee's live till credentials, found whatever branch they sit at
  perform set_config('app.actor_id', v_system::text, true);
  select coalesce(array_agg(c.principal_id), '{}') into v_cashiers
    from app.pos_cashier c
   where c.employee_id = new.id and c.revoked_at is null;
  perform set_config('app.actor_id', coalesce(v_caller, ''), true);

  -- 2. every live assignment of the person's login identity, as the terminating actor. `expires_at`, never DELETE:
  --    spec:2049 keeps the history. 6C's trigger refreshes each credential's snapshot as its assignments expire.
  update app.role_assignment
     set expires_at = now()
   where (principal_id = new.principal_id or principal_id = any (v_cashiers))
     and (expires_at is null or expires_at > now());

  -- 3. the credentials themselves, last. `revoked_at is null` keeps the FIRST revocation instant on a repeat, so 6C's
  --    tombstone trigger fires once per credential.
  if cardinality(v_cashiers) > 0 then
    perform set_config('app.actor_id', v_system::text, true);
    update app.pos_cashier
       set revoked_at = now()
     where principal_id = any (v_cashiers)
       and revoked_at is null;
    perform set_config('app.actor_id', coalesce(v_caller, ''), true);
  end if;

  return null;   -- AFTER trigger: the return value is ignored
end $$;

-- `old.terminated_on is null and new.terminated_on is not null`, never `is distinct from`: a corrected date would
-- write a second tombstone for a person already tombstoned, and clearing the column (a reinstatement) would run the
-- revocation on the transition meant to undo it. A reinstatement is an explicit act — a new credential, new roles.
create trigger employee_terminated after update of terminated_on on app.employee
  for each row when (old.terminated_on is null and new.terminated_on is not null)
  execute function app.terminate_employee();

comment on function app.terminate_employee() is
  'spec:2090 — the termination trigger (ADR 0078). Expires the role assignments as the terminating actor (R4, forbid_self_grant and keep_last_admin_* still apply), then revokes the till credentials as the tenant''s system principal so a credential at a branch the actor cannot see is revoked too.';
