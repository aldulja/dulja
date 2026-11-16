create table app.currency (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references app.tenant(id),
  code char(3) not null,
  name_en text not null,
  name_ar text,
  minor_units smallint not null default 2,
  pos_rounding_increment numeric(19,4) not null default 0.01,
  rounding_mode text not null default 'HALF_AWAY_FROM_ZERO' check (rounding_mode in ('HALF_AWAY_FROM_ZERO','HALF_EVEN','TOWARD_ZERO','AWAY_FROM_ZERO')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, code), unique (tenant_id, id)
);
call app_meta.enable_tenant_rls('app.currency');
call app_meta.attach_audit('app.currency');

create table app.exchange_rate (
  id uuid primary key default uuidv7(), tenant_id uuid not null references app.tenant(id), company_id uuid not null,
  from_currency char(3) not null, to_currency char(3) not null,
  rate numeric(19,8) not null check (rate > 0), effective_from date not null, source text not null,
  entered_by uuid not null default app.current_actor() references app.principal(id), created_at timestamptz not null default now(),
  unique (company_id, from_currency, to_currency, effective_from), unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.exchange_rate');
call app_meta.attach_audit('app.exchange_rate');
call app_meta.attach_stamp('app.exchange_rate', 'entered_by');
create index exchange_rate_lookup_idx on app.exchange_rate (company_id, from_currency, to_currency, effective_from desc);

create function app.rate_for(p_company uuid, p_from char(3), p_to char(3), p_on date) returns app.exchange_rate
language sql stable as $$
  select r.* from app.exchange_rate r where r.company_id = p_company and r.from_currency = p_from and r.to_currency = p_to and r.effective_from <= p_on order by r.effective_from desc limit 1
$$;
