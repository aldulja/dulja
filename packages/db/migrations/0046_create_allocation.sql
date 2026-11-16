-- 0046_create_allocation.sql
-- Slice 4A. app.allocation — which settlement paid which invoice (contracts §4.8.1, spec:1042).
-- It is NOT a ledger table: a receipt relieves the AR control account in total when it posts, and this table
-- records the apportionment. That is what lets `unallocate` exist without touching a posted entry
-- (spec:2457, LEGACY-041). The `posting-only-tables` lint (§3.7.5) does not list it and must not gain it.
-- Financial rows: reversed by `unallocated_at`, never deleted (spec:2049); §3.5.4's DELETE list is unchanged.

-- ── 1. the table (§4.8.1's DDL, with Task 0's amendment 11 columns and CHECK) ─────────────────────────
create table app.allocation (
  id                     uuid primary key default uuidv7(),                -- §3.2 identifiers (LEGACY-021)
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  party_id               uuid not null,
  settlement_document_id uuid not null,                                    -- RECEIPT / PAYMENT / credit note
  settled_document_id    uuid not null,                                    -- invoice / credit note being settled
  amount                 numeric(19,4) not null,                           -- document currency of the SETTLED document (spec:2041)
  -- 4B (ADR 0047 decision 9, a proposal): the same payment in the SETTLEMENT document's currency — a USD
  -- receipt paying a EUR invoice states both figures, because neither derives from the other without a cross
  -- rate nobody entered. Equal to `amount` when the two documents share a currency (allocateSettlement's
  -- rule; a CHECK cannot see the documents). 0046 has never been applied to any database, so the column is
  -- added here rather than by a migration of its own.
  settlement_amount      numeric(19,4) not null,                           -- document currency of the SETTLEMENT (spec:2041)
  base_amount            numeric(19,4) not null,                           -- at the SETTLED document's rate (spec:1816)
  fx_difference          numeric(19,4) not null default 0,                 -- base: settlement base − settled base; 4B posts it (§4.15)
  -- Code review B1: the allocation's own ACCOUNTING date — the date from which 4B's ageing relieves both of
  -- its documents and on which its realised FX difference posts. The later of the two documents' effective
  -- dates, moved forward to the first day of the earliest OPEN fiscal period when that date's period is not
  -- open (app.first_open_date, §5). Stamped by allocation_guard at insert, never the caller's: dated on the
  -- documents alone, an allocation made after their period closed rewrote that period's ageing and its FX
  -- document could never post.
  effective_date         date not null,
  allocated_by           uuid not null default app.current_actor() references app.principal(id),  -- stamped below (LEGACY-044)
  unallocated_at         timestamptz,                                      -- the reversal: set once, never cleared (spec:2457)
  unallocated_by         uuid references app.principal(id),                -- stamped on the NULL → value transition (amendment 11)
  unallocation_reason    text,                                             -- the reason `unallocate` compels (amendment 11, ADR 0023)
  unallocated_on         date,                                             -- B1: the un-allocation's accounting date, stamped with unallocated_at
  created_at             timestamptz not null default now(),
  constraint allocation_amount_check   check (amount > 0),                 -- §4.8.1's DDL: a magnitude, never a sign
  constraint allocation_settlement_amount_check check (settlement_amount > 0),  -- the same, in the settlement's currency (4B)
  constraint allocation_distinct_check check (settlement_document_id <> settled_document_id),  -- amendment 11
  -- B1: an un-allocation carries its accounting date, never before the allocation's own
  constraint allocation_unallocated_on_check
    check ((unallocated_at is null) = (unallocated_on is null) and unallocated_on >= effective_date),
  unique (tenant_id, id),
  -- composite: an FK check bypasses RLS, so a plain `references` would admit another tenant's row (LEGACY-035)
  foreign key (tenant_id, company_id)             references app.company(tenant_id, id),
  foreign key (tenant_id, party_id)               references app.party(tenant_id, id),
  foreign key (tenant_id, settlement_document_id) references app.document(tenant_id, id),
  foreign key (tenant_id, settled_document_id)    references app.document(tenant_id, id)
);

-- ── 2. the two lookups every read of this table performs (§4.8.1, Task 0 amendment 11) ────────────────
-- `allocateSettlement`'s capacity read and `listAllocations({ settlementDocumentId })` scan by settlement;
-- `openBalance` and `listAllocations({ settledDocumentId })` scan by settled document. PARTIAL, because a
-- reversed allocation is never one of those reads — every one of them carries `unallocated_at is null`.
-- Plain `create index`, never `concurrently`: a migration file runs whole in one transaction (§3.4.5).
create index allocation_settlement_idx on app.allocation (settlement_document_id) where unallocated_at is null;  -- §4.8.1
create index allocation_settled_idx    on app.allocation (settled_document_id)    where unallocated_at is null;  -- §4.8.1

-- ── 3. the column comment ADR 0023's loss makes load-bearing ───────────────────────────────────────────
comment on column app.allocation.unallocation_reason is
  'The reason `unallocate` compels its caller to supply. It is a COLUMN and not a log line: app.audit_row '
  'writes to_jsonb(new) of the row, so a value never written to a column cannot appear in the audit image — '
  'the same loss ADR 0023 fixed for fiscal_period.reopen_reason by making it a column (contracts §4.8.1).';

-- ── 4. tenancy, audit, stamps, privileges (§3.5.1) ─────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.allocation');               -- spec:106; policy `tenant_isolation`, RLS enabled AND forced
call app_meta.attach_audit('app.allocation');                    -- spec:106; every allocation and un-allocation is audited
call app_meta.attach_stamp('app.allocation', 'allocated_by');    -- §3.5.1 step 4; the *_by rule of §3.3 (LEGACY-044)
call app_meta.attach_stamp('app.allocation', 'unallocated_by');  -- BOTH stamps, exactly as §4.8.3's bank_match carries two
-- Two stamps and not one, for the same two reasons §4.8.3 gives bank_match's matched_by/unmatched_by pair:
-- the stamp_actor LINTER rule fires on every *_by column with no stamp_<col> trigger (plan0A:2755-2758) and
-- §3.5.2 requires zero violations; and app.stamp_actor() stamps on the NULL → value transition and RAISES
-- ERR_ACTOR_IMMUTABLE on a change from one non-null actor to another (plan0A:2372-2385), which is exactly
-- unallocate's shape — allocated_by is untouched by that UPDATE and unallocated_by is set once, for ever.
-- app_rw receives select, insert, update through default privileges (plan0A:2564). NO DELETE: an allocation
-- is reversed by setting unallocated_at, never removed (§3.5.4's pinned list is unchanged by this slice).

-- ── 5. the accounting dates, and what an UPDATE may change: the un-allocation, once (spec:2457, LEGACY-041) ──
-- app.first_open_date (code review B1): `p_date` when its fiscal period of `p_company` is open, else the
-- first day of the earliest OPEN period after it; NULL when there is none. The period it returns is read
-- `for share`, as postDocument's step 5 reads the one it posts into, so a concurrent close of that period
-- waits for this transaction instead of committing 'closed' under an allocation just dated inside it.
create function app.first_open_date(p_company uuid, p_date date) returns date
language plpgsql as $$
declare
  d date;
begin
  select case when p_date between p.starts_on and p.ends_on then p_date else p.starts_on end
    into d
    from app.fiscal_period p
   where p.company_id = p_company and p.status = 'open' and p.ends_on >= p_date
   order by p.starts_on
   limit 1
   for share;
  return d;
end
$$;
comment on function app.first_open_date(uuid, date) is
  'Code review B1: p_date when its fiscal period is open, else the first day of the earliest open period after '
  'it (NULL: none). allocation_guard dates an allocation and its un-allocation with it.';
revoke all on function app.first_open_date(uuid, date) from public;
grant execute on function app.first_open_date(uuid, date) to app_rw;

-- An allocation is a financial row reversed by setting `unallocated_at`, so the ONE legal update is that
-- transition, with its reason and its stamped actor. Every figure and every reference is fixed at insert: a
-- direct app_rw UPDATE of `amount` or `base_amount` would change what an invoice's open balance and 4B's
-- ageing say without any audit-visible reversal, and clearing `unallocated_at` would resurrect a reversed
-- allocation. The stamp triggers still guard the two *_by columns on their own.
--
-- The two accounting dates are the guard's to write, whatever the statement supplied (B1). At INSERT,
-- `effective_date` = app.first_open_date(greatest(settlement date, settled date)); at the un-allocation,
-- `unallocated_on` = app.first_open_date(effective_date). 4B's ageing counts an allocation as live on
-- [effective_date, unallocated_on) and the realised FX documents are dated on the same two days
-- (packages/db/src/ar-ap/fx.ts), so the ageing ties to the control account at every as-of date — and an
-- allocation or un-allocation made after a period closed lands in the first open one, leaving the closed
-- period's ageing as it was reported. No open period on or after the date: refused, as postDocument
-- refuses a posting into a period that is not open.
create function app.allocation_guard() returns trigger language plpgsql as $$
declare
  on_date date;
begin
  if tg_op = 'INSERT' then
    if new.unallocated_at is not null or new.unallocated_by is not null
       or new.unallocation_reason is not null or new.unallocated_on is not null then
      raise exception 'ERR_TABLE_IMMUTABLE: an allocation is inserted live; it is unallocated by updating its own row'
        using errcode = 'check_violation';
    end if;
    select greatest(s.effective_date, t.effective_date) into on_date
      from app.document s, app.document t
     where s.id = new.settlement_document_id and t.id = new.settled_document_id;
    if on_date is null then
      raise exception 'ERR_NOT_FOUND: allocation % names a document that is not visible', new.id
        using errcode = 'check_violation';
    end if;
    new.effective_date := app.first_open_date(new.company_id, on_date);
    if new.effective_date is null then
      raise exception 'ERR_PERIOD_NOT_OPEN: company % has no open fiscal period on or after %, so allocation % has no accounting date', new.company_id, on_date, new.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.tenant_id, new.company_id, new.party_id, new.settlement_document_id, new.settled_document_id,
      new.amount, new.settlement_amount, new.base_amount, new.fx_difference, new.effective_date,
      new.allocated_by, new.created_at)
     is distinct from
     (old.tenant_id, old.company_id, old.party_id, old.settlement_document_id, old.settled_document_id,
      old.amount, old.settlement_amount, old.base_amount, old.fx_difference, old.effective_date,
      old.allocated_by, old.created_at) then
    raise exception 'ERR_TABLE_IMMUTABLE: allocation % is fixed at insert; unallocate it and allocate again', old.id
      using errcode = 'check_violation';
  end if;
  if old.unallocated_at is not null then
    raise exception 'ERR_TABLE_IMMUTABLE: allocation % is already unallocated; a reversal is never undone', old.id
      using errcode = 'check_violation';
  end if;
  if new.unallocated_at is null then
    raise exception 'ERR_TABLE_IMMUTABLE: allocation % changes only by being unallocated', old.id
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(new.unallocation_reason), '') is null then
    raise exception 'ERR_VALIDATION_FAILED: unallocating allocation % needs a reason (spec:2457)', old.id
      using errcode = 'check_violation';
  end if;
  new.unallocated_on := app.first_open_date(old.company_id, old.effective_date);
  if new.unallocated_on is null then
    raise exception 'ERR_PERIOD_NOT_OPEN: company % has no open fiscal period on or after %, so allocation % cannot be unallocated', old.company_id, old.effective_date, old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger allocation_guard before insert or update on app.allocation
  for each row execute function app.allocation_guard();  -- LEGACY-041: live at insert, reversal only, and only once; B1's dates
