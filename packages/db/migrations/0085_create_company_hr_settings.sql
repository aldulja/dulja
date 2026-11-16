-- ── 0085_create_company_hr_settings.sql ────────────────────────────────────────────────────────
-- §3.10.1 "Proration" (spec:2086) and "Employer registration identifiers" (spec:2088).
-- ⚠️ OD-23. Two settings and no blob: the employer registration numbers live RELATIONALLY, one per
-- scheme, on app.statutory_scheme.employer_registration (migration 0084, amendment A3). spec:2088:
-- "relational company settings supplied by the owner -- never a blob (§4.1)". §4.6.1's
-- `employer_registrations jsonb` "display copy" is deliberately NOT built (amendment A4): a second
-- store with no rebuild path is LEGACY-078 in miniature, and one join reads them all.
-- No row is seeded: until the owner confirms (OD-23) a company has none, and a reader takes the
-- §2.12 default (`calendar_days`, no pay day).

create table app.company_hr_setting (
  id             uuid primary key default uuidv7(),
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  proration_rule text not null default 'calendar_days',
  pay_day        smallint,
  created_at     timestamptz not null default now(),
  constraint company_hr_setting_proration_rule_check check (proration_rule in ('calendar_days', 'working_days')),
  constraint company_hr_setting_pay_day_check        check (pay_day is null or (pay_day between 1 and 31)),
  unique (company_id),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.company_hr_setting');
call app_meta.attach_audit('app.company_hr_setting');

comment on column app.company_hr_setting.proration_rule is
  '⚠️ OD-23/OD-28. spec:2086: proration for mid-month joiners, leavers and unpaid days follows "a company-level configured rule (calendar days or working days) that the accountant confirms -- CONFIGURATION, never a statutory claim". 8B reads it; this slice only stores it.';
comment on column app.company_hr_setting.pay_day is
  '⚠️ OD-23. The day of the month wages are paid. Null until the owner confirms; 8B''s PayPeriod.payDate is entered per run and never derived from a null.';
