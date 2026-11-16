-- ── 0124 · a system role is immutable to app_rw ────────────────────────────────────────────────────
-- 2026-11-15 full review, finding API-03 (blocker); ADR 0091 (Proposed). Tail number allocated by the review's
-- orchestrator.
--
-- spec:2152: the seeded roles are "never renamed or archived; their permissions change only by migration, so a
-- change is a reviewed diff". Nothing enforced it. The only guard on app.role_permission was 0001's
-- forbid_self_grant, which refuses a role the ACTOR holds, so a holder of admin.role.manage could rewrite the
-- seeded `user` role — held in every company — through PUT /v1/admin/roles/{id}/permissions. The API now refuses
-- (409 ERR_RBAC_SYSTEM_ROLE); this trigger is the same rule in the data layer, so no other app_rw path can do it.
--
-- Who may still write: any session that is not app_rw (the migrator, which runs migrations and `bun run seed`),
-- and an app_rw session whose actor is the tenant's SYSTEM principal (the seed's roles loader, run in tests over
-- app_rw). A request's actor is never the system principal: auth resolves a human or a terminal.
--
-- Assigning a system role is untouched: that is app.role_assignment, governed by forbid_self_grant and, in the
-- API, by ADR 0091's assignment ceiling.

create function app.guard_system_role() returns trigger language plpgsql as $$
declare
  v_role_id uuid;
  v_system boolean;
begin
  if current_user <> 'app_rw' or exists (
    select 1 from app.principal p where p.id = app.current_actor() and p.kind = 'system'
  ) then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'role' then
    if (tg_op = 'INSERT' and new.is_system)
       or (tg_op = 'UPDATE' and (old.is_system or new.is_system))
       or (tg_op = 'DELETE' and old.is_system) then
      raise exception 'ERR_RBAC_SYSTEM_ROLE: a system role is changed only by migration (spec:2152)'
        using errcode = 'check_violation';
    end if;
  else
    for v_role_id in select distinct r from unnest(array[
        case when tg_op <> 'INSERT' then old.role_id end,
        case when tg_op <> 'DELETE' then new.role_id end]) r where r is not null
    loop
      select is_system into v_system from app.role where id = v_role_id;
      if coalesce(v_system, false) then
        raise exception 'ERR_RBAC_SYSTEM_ROLE: a system role''s permissions change only by migration (spec:2152)'
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  return coalesce(new, old);
end $$;

create trigger role_guard_system before insert or update or delete on app.role
  for each row execute function app.guard_system_role();
create trigger role_permission_guard_system before insert or update or delete on app.role_permission
  for each row execute function app.guard_system_role();
