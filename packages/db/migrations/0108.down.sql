-- 0108.down.sql — restores 0001's assert_assignment_kind body verbatim.
alter table app.pos_terminal drop constraint if exists pos_terminal_membership_fk;
alter table app.role_assignment drop constraint if exists role_assignment_membership_fk;
create or replace function app.assert_assignment_kind() returns trigger language plpgsql as $$
declare v_kind app.principal_kind; v_code text;
begin
  select kind into v_kind from app.principal where id = new.principal_id;
  select code into v_code from app.role where id = new.role_id;
  if v_kind = 'system' then
    raise exception 'ERR_RBAC_KIND: the system principal holds no role' using errcode = 'check_violation';
  elsif (v_kind = 'terminal') <> (v_code = 'pos_terminal') then
    raise exception 'ERR_RBAC_KIND: role % cannot be assigned to a principal of kind %', v_code, v_kind using errcode = 'check_violation';
  end if;
  return new;
end $$;
