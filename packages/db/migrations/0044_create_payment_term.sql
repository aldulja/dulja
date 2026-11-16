-- 0044_create_payment_term.sql
-- Slice 4A. app.payment_term — the terms an invoice is aged on (spec:1042 "payment terms"; contracts §4.6.1).
-- Master data: archived, never deleted (spec:2049); §3.5.4's app_rw DELETE list is unchanged by this file.

-- ── 1. the table ───────────────────────────────────────────────────────────────────────────────────────
create table app.payment_term (
  id             uuid primary key default uuidv7(),                       -- §3.2 identifiers (LEGACY-021)
  tenant_id      uuid not null references app.tenant(id),
  company_id     uuid not null,
  code           text not null,
  name_en        text not null,                                            -- spec:2045 bilingual master data, not a JSON blob
  name_ar        text,
  due_days       int not null,                                             -- §4.8.2: the ageing buckets are cut on this
  discount_days  int,
  discount_pct   numeric(9,6),                                             -- a FRACTION, not money: 0.020000 is two per cent
  archived_at    timestamptz,                                              -- spec:2049: master data is archived, never deleted
  created_at     timestamptz not null default now(),
  constraint payment_term_due_days_check         check (due_days >= 0),
  constraint payment_term_discount_pct_check     check (discount_pct is null or (discount_pct > 0 and discount_pct < 1)),
  -- a discount window that ends after the due date is not a discount window; days and pct travel together
  constraint payment_term_discount_window_check  check (
    (discount_days is null and discount_pct is null)
    or (discount_days is not null and discount_pct is not null and discount_days >= 0 and discount_days <= due_days)),
  constraint payment_term_company_id_code_key unique (company_id, code),   -- contracts §4.6.1
  unique (tenant_id, id),                                                  -- the target of 0045's composite FKs
  -- composite: an FK check bypasses RLS, so a plain `references` would admit another tenant's company (LEGACY-035)
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

-- ── 2. tenancy, audit, privileges (§3.5.1) ─────────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.payment_term');   -- policy `tenant_isolation`, RLS enabled AND forced (spec:106)
call app_meta.attach_audit('app.payment_term');         -- spec:106; test 13 covers this table from now on
-- app_rw receives select, insert, update through default privileges (plan0A:2564). No DELETE (§3.5.4).
-- No *_by column, so no attach_stamp (contracts §3.3's naming rule).

-- ── 3. the due-date function (§4.8.2) ──────────────────────────────────────────────────────────────────
-- Computed in SQL so no JavaScript date arithmetic and no session timezone can enter an accounting date
-- (§3.2: effective_date is a `date`, entered by the user, never derived from a timestamp). `stable` and an
-- unqualified read, so it runs under the caller's RLS: a term the caller cannot see yields null, never a date.
create function app.payment_due_date(p_payment_term_id uuid, p_effective_date date) returns date
language sql stable as $$
  select case
           when p_payment_term_id is null then p_effective_date
           else p_effective_date + (select t.due_days from app.payment_term t where t.id = p_payment_term_id)
         end
$$;
comment on function app.payment_due_date(uuid, date) is
  'contracts §4.8.2: the ageing buckets are cut on effective_date + due_days of the term PINNED on the document.';
