-- 0021_create_document_event.sql ──────────────────────────────────────────────────────────────────────────
-- The append-only record of every status change and every override on a document.
-- spec:1782–1787 forward-declares it; contracts §4.5.2 fixes the columns; C11 is resolved with event_kind.
-- Handlers never write this table: the AFTER UPDATE OF status trigger of migration 0022 writes 'transition'
-- rows and the override door below is the only other way in (spec:1786, SAH-044).

-- ── 1. the table ──────────────────────────────────────────────────────────────────────────────────────
create table app.document_event (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  document_id    uuid not null,
  event_kind     text not null check (event_kind in ('transition', 'override')),
  from_status    app.document_status not null,
  to_status      app.document_status not null,                  -- override: from_status = to_status = the status at the time
  override_code  text references app.permission(code),          -- overrides only; plain FK: permission is a global catalogue
  actor_id       uuid not null default app.current_actor() references app.principal(id),   -- stamped; never from a payload (SAH-044)
  attributed_to  uuid references app.principal(id),             -- the supervisor or cashier the event belongs to — DATA (spec:1785)
  occurred_at    timestamptz not null default now(),            -- the business time; created_at is the row time
  reason         text,
  created_at     timestamptz not null default now(),
  check ((event_kind = 'transition' and override_code is null and from_status <> to_status)
      or (event_kind = 'override'   and override_code is not null and from_status = to_status)),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, document_id) references app.document(tenant_id, id)
);
comment on table app.document_event is
  'Append-only lifecycle record. R1 (maker <> checker) is read from here by app.document_status_before (spec:2172).';

create index document_event_document_idx on app.document_event (document_id, occurred_at);

call app_meta.enable_tenant_rls('app.document_event');
call app_meta.attach_stamp('app.document_event', 'actor_id');    -- spec:1370 names actor_id explicitly, though it is not *_by

-- Immutable: no audit trigger (it is already in AUDIT_EXEMPT), no UPDATE/DELETE for app_rw (already in IMMUTABLE).
create trigger document_event_immutable before update or delete on app.document_event
  for each row execute function app.forbid_change();
revoke update, delete on app.document_event from app_rw;

-- ── 2. app.principal_has — the parameterised twin of app.actor_has (contracts §4.5.3) ─────────────────
-- Identical body to app.actor_has (0001 §3) with p_principal in place of app.current_actor().
-- app.actor_has itself is untouched. A NULL branch asks for company-wide authority and is granted only by an
-- assignment with no branch rows, so a branch-restricted principal never gains anything by omitting the
-- branch (SAH-042, SAH-050 — never fail open).
create function app.principal_has(p_principal uuid, p_code text, p_company_id uuid, p_branch_id uuid default null)
returns boolean language sql stable as $$
  select exists (
    select 1 from app.principal p join app.membership m on m.principal_id = p.id
     where p.id = p_principal and p.kind = 'system' and m.tenant_id = app.current_tenant())
  or exists (
    select 1
      from app.role_assignment ra
      join app.role_permission rp on rp.role_id = ra.role_id
     where ra.principal_id = p_principal
       and ra.company_id   = p_company_id
       and rp.permission_code = p_code
       and (ra.expires_at is null or ra.expires_at > now())
       and (not exists (select 1 from app.role_assignment_branch b
                         where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id)
            or (p_branch_id is not null and exists (
                  select 1 from app.role_assignment_branch b
                   where b.principal_id = ra.principal_id and b.role_id = ra.role_id and b.company_id = ra.company_id
                     and b.branch_id = p_branch_id))))
$$;

-- ── 3. the override door (R8, spec:2179; SAH-027, SAH-048) ────────────────────────────────────────────
-- An override is an explicit permission exercised per document by a SECOND principal and recorded here,
-- never a session flag. POS: actor_id is the terminal and attributed_to the supervisor whose PIN authorised
-- it; back office: actor_id is the second principal and attributed_to is null.
create function app.assert_override_authorised() returns trigger language plpgsql as $$
declare
  d app.document%rowtype;
  p uuid := coalesce(new.attributed_to, new.actor_id);
begin
  select * into d from app.document where id = new.document_id;
  if d.id is null then
    raise exception 'ERR_OVERRIDE_NOT_AUTHORISED: document % is not visible', new.document_id using errcode = 'check_violation';
  end if;
  if not app.principal_has(p, new.override_code, d.company_id, d.branch_id) then
    raise exception 'ERR_OVERRIDE_NOT_AUTHORISED: principal % does not hold % at branch %', p, new.override_code, d.branch_id using errcode = 'check_violation';
  end if;
  if p = d.created_by or p is not distinct from d.attributed_to then
    raise exception 'ERR_OVERRIDE_NOT_AUTHORISED: an override on document % needs a second principal', d.id using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- BEFORE INSERT triggers fire in alphabetical order, so document_event_override_guard runs before
-- stamp_actor_id; new.actor_id already carries the column default app.current_actor() at that point.
create trigger document_event_override_guard before insert on app.document_event
  for each row when (new.event_kind = 'override') execute function app.assert_override_authorised();
