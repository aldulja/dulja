create table app.custom_field_definition (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references app.tenant(id),
  company_id uuid not null,
  entity text not null check (entity in ('document','party','item','employee')),
  document_type_id uuid,
  code text not null,
  name_en text not null,
  name_ar text,
  kind text not null check (kind in ('text','integer','decimal','money','date','boolean','dimension_value','enum')),
  required boolean not null default false,
  options jsonb not null default '{}'::jsonb,
  indexed boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, entity, code),
  unique (tenant_id, id),
  foreign key (tenant_id, company_id) references app.company(tenant_id, id),
  foreign key (tenant_id, document_type_id) references app.document_type(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.custom_field_definition');
call app_meta.attach_audit('app.custom_field_definition');

create table app.custom_field_value (
  id uuid primary key default uuidv7(),
  tenant_id uuid not null references app.tenant(id),
  definition_id uuid not null,
  entity_id uuid not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  unique (definition_id, entity_id),
  unique (tenant_id, id),
  foreign key (tenant_id, definition_id)
    references app.custom_field_definition(tenant_id, id)
);
call app_meta.enable_tenant_rls('app.custom_field_value');
call app_meta.attach_audit('app.custom_field_value');

create index custom_field_value_lookup_idx
  on app.custom_field_value (definition_id, (value));
