-- ── 0107 · a closed period is immutable in more than its status; a ledger entry fits its period ──────
-- Review remediation (Phase 2 review pass, PR #5); §3.4.1 tail number. Depends on 0001, 0005 and 0013.
--
-- 1. fiscal_period. 0001 guarded nothing but `closed_by`; app_rw holds UPDATE on the table. So a closed
--    February could have its ends_on pulled back and a new open period inserted over the days it gave up,
--    and a posting dated inside the "closed" month would then resolve to the new period and pass
--    assert_period_open. And 0013's reopen_reason (spec:2179 R8) was required by the API alone. The guard:
--    a period never changes company; its dates change only while open and never so that an existing ledger
--    entry falls outside them; and closed|locked → open needs a reason, whatever path writes it.
create function app.guard_fiscal_period() returns trigger language plpgsql as $$
begin
  if new.company_id <> old.company_id then
    raise exception 'ERR_PERIOD_STATUS_ILLEGAL: fiscal period % cannot move to another company', old.id
      using errcode = 'check_violation';
  end if;
  if (new.starts_on, new.ends_on) <> (old.starts_on, old.ends_on) then
    if old.status <> 'open' then
      raise exception 'ERR_PERIOD_STATUS_ILLEGAL: fiscal period % is %; its dates cannot change', old.id, old.status
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from app.ledger_entry
                where fiscal_period_id = old.id
                  and effective_date not between new.starts_on and new.ends_on) then
      raise exception 'ERR_PERIOD_STATUS_ILLEGAL: fiscal period % holds ledger entries outside % .. %', old.id, new.starts_on, new.ends_on
        using errcode = 'check_violation';
    end if;
  end if;
  if old.status in ('closed', 'locked') and new.status = 'open' and nullif(new.reopen_reason, '') is null then
    raise exception 'ERR_VALIDATION_FAILED: reopening fiscal period % needs a reason (spec:2179 R8)', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger fiscal_period_guard before update on app.fiscal_period
  for each row execute function app.guard_fiscal_period();

-- 2. ledger_entry. assert_period_open (0001) checks the period's status and nothing else: a row could name a
--    period of another company, or a period that does not contain its effective_date. The posting service
--    never does either, and the schema now says so too.
create function app.assert_period_fits() returns trigger language plpgsql as $$
declare p record;
begin
  select company_id, starts_on, ends_on into p from app.fiscal_period where id = new.fiscal_period_id;
  if p.company_id is null then
    raise exception 'ERR_PERIOD_NOT_FOUND: fiscal period % is not visible', new.fiscal_period_id using errcode = 'check_violation';
  end if;
  if p.company_id <> new.company_id then
    raise exception 'ERR_PERIOD_NOT_FOUND: fiscal period % belongs to another company', new.fiscal_period_id using errcode = 'check_violation';
  end if;
  if new.effective_date not between p.starts_on and p.ends_on then
    raise exception 'ERR_PERIOD_NOT_FOUND: % lies outside fiscal period %', new.effective_date, new.fiscal_period_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger ledger_entry_period_fits before insert on app.ledger_entry
  for each row execute function app.assert_period_fits();

-- 3. currency. `pos_rounding_increment` had no lower bound; the first consumer divides by it (6B). The
--    contract's IncrementSchema now refuses 0.0000 too; this is the schema's half.
alter table app.currency add constraint currency_pos_rounding_increment_positive check (pos_rounding_increment > 0);
