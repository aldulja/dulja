-- 0091_create_statutory_schedule_and_remittance_guard.sql
-- §3.10.1 Outputs (spec:2083): "a monthly contribution/deduction schedule per scheme … recorded as one
-- statutory_schedule row per scheme per period (generated from posted lines only; attachment hash; the
-- remittance PAYMENT that settled it) — A RECORD, NOT A LODGEMENT STATE MACHINE."
-- There is therefore no `status` column and no transition anywhere in this file: a schedule exists, and it
-- either has a settling payment or it has not. Contracts §4.6.1 + round 18 B1, B11.

-- ── 1. the table (§4.6.1 + amendment B11) ───────────────────────────────────────────────────────────
create table app.statutory_schedule (
  id                     uuid primary key default uuidv7(),
  tenant_id              uuid not null references app.tenant(id),
  company_id             uuid not null,
  scheme_id              uuid not null,
  period_start           date not null,
  period_end             date not null,
  payroll_document_id    uuid not null,                    -- the PAYROLL run these figures were generated from
  total_employee         numeric(19,4) not null,
  total_employer         numeric(19,4) not null,
  currency               char(3) not null,                 -- B11: the totals carry no currency of their own
  attachment_id          uuid,                             -- the generated CSV and its sha256 (2C's app.attachment)
  remittance_document_id uuid,                             -- the PAYMENT that settled it (spec:2083)
  generated_by           uuid not null default app.current_actor() references app.principal(id),   -- stamped
  created_at             timestamptz not null default now(),
  constraint statutory_schedule_period_check check (period_end >= period_start),
  constraint statutory_schedule_total_employee_check check (total_employee >= 0),
  constraint statutory_schedule_total_employer_check check (total_employer >= 0),
  constraint statutory_schedule_scheme_period_run_key unique (scheme_id, period_start, payroll_document_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id)             references app.company(tenant_id, id),
  foreign key (tenant_id, scheme_id)              references app.statutory_scheme(tenant_id, id),
  foreign key (tenant_id, payroll_document_id)    references app.document(tenant_id, id),
  foreign key (tenant_id, attachment_id)          references app.attachment(tenant_id, id),
  foreign key (tenant_id, remittance_document_id) references app.document(tenant_id, id)
);
comment on table app.statutory_schedule is
  'spec:2083 — one row per scheme per period, generated from POSTED payroll lines only. A record, not a lodgement state machine.';
comment on column app.statutory_schedule.total_employer is
  'The employer share. A scheme with no employer share carries 0.0000 here — whether it has one is a rate-table fact (contracts §4.12.3), never a code fact.';

call app_meta.enable_tenant_rls('app.statutory_schedule');
call app_meta.attach_audit('app.statutory_schedule');
call app_meta.attach_stamp('app.statutory_schedule', 'generated_by');

create index statutory_schedule_scheme_period_idx
  on app.statutory_schedule (company_id, scheme_id, period_start);
create index statutory_schedule_payroll_idx
  on app.statutory_schedule (payroll_document_id);
-- One PAYMENT settles exactly one schedule (8C T8). The guard below measures the payment's WHOLE bank leg, so without
-- this a payment could be linked to two schedules whose totals happen to agree (two schemes, or a run and its
-- supplementary) and pay both on paper. Amended in place on 2026-11-07, never having been applied outside a test
-- database (the Phase 7 0075/0077/0078 precedent).
create unique index statutory_schedule_remittance_key
  on app.statutory_schedule (remittance_document_id) where remittance_document_id is not null;

-- ── 2. the remittance-amount guard (spec:2082 "refused if the amount differs from the schedule they
--       settle"; acceptance test 30's fourth clause) ────────────────────────────────────────────────────
-- A TRIGGER, not a handler check, because test 30 exercises "through any path" and a direct `app_rw` update is
-- one of them. It measures the PAYMENT's own bank leg rather than a stored total: a document has no `total`
-- column, the ledger is the record, and a leg is what a bank statement will later match (4B's `Reconcilable`,
-- §4.8.3). `1100` is the §4.15 bank account, seeded by 0C. Because the guard measures the payment's WHOLE bank
-- leg, one PAYMENT settles exactly one schedule.
--
-- The `UPDATE OF` list is three columns: a column-scoped trigger fires only when a named column is in the SET
-- list, so without the two totals an already-settled row's totals could move while `remittance_document_id`
-- stayed put, and the row would go on claiming a settlement for an amount it no longer holds. An unsettled row
-- returns at the first statement, so an ordinary generation pays nothing.
--
-- The money mask carries fifteen integer positions — the range of numeric(19,4); `to_char` renders a value that
-- does not fit its mask as `#`s rather than raising, so a narrower mask would corrupt the message silently.
create function app.assert_remittance_matches_schedule() returns trigger language plpgsql as $$
declare
  paid       numeric(19,4);
  doc_status app.document_status;
  doc_company uuid;
  total      numeric(19,4) := new.total_employee + new.total_employer;
begin
  if new.remittance_document_id is null then
    return new;
  end if;

  select d.status, d.company_id into doc_status, doc_company
    from app.document d where d.id = new.remittance_document_id;
  if doc_status is null then
    raise exception 'ERR_PAYROLL_REMITTANCE_MISMATCH: payment % is not visible', new.remittance_document_id
      using errcode = 'check_violation';
  end if;
  -- The composite FK bounds the tenant only; a payment of another company of the tenant settles nothing here.
  if doc_company <> new.company_id then
    raise exception 'ERR_PAYROLL_REMITTANCE_MISMATCH: payment % belongs to another company than schedule %',
      new.remittance_document_id, new.id using errcode = 'check_violation';
  end if;
  if doc_status <> 'posted' then
    raise exception 'ERR_PAYROLL_REMITTANCE_MISMATCH: payment % is not posted (status %)',
      new.remittance_document_id, doc_status using errcode = 'check_violation';
  end if;

  -- The money that LEFT the bank on that document: credits minus debits on the company's `1100` account.
  -- coalesce, deliberately (SAH-011): a payment with no bank leg reads 0 and is refused by the comparison
  -- below, never NULL-propagated into a silent pass.
  select coalesce(sum(le.credit) - sum(le.debit), 0) into paid
    from app.ledger_entry le
    join app.account a on a.id = le.account_id
   where le.document_id = new.remittance_document_id
     and a.company_id = new.company_id
     and a.code = '1100';

  if paid <> total then
    raise exception
      'ERR_PAYROLL_REMITTANCE_MISMATCH: schedule % settles %, payment % moves %',
      new.id, to_char(total, 'FM999999999999990.0000'), new.remittance_document_id,
      to_char(paid, 'FM999999999999990.0000')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger statutory_schedule_remittance_guard
  before insert or update of remittance_document_id, total_employee, total_employer
    on app.statutory_schedule
  for each row execute function app.assert_remittance_matches_schedule();
