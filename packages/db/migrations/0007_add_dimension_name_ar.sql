alter table app.dimension_type add column name_ar text;
alter table app.dimension_value add column name_ar text;

comment on column app.dimension_type.name_ar is
  'spec §3.9 Naming — the Arabic label; null until a tenant supplies one.';
comment on column app.dimension_value.name_ar is
  'spec §3.9 Naming — the Arabic label; null until a tenant supplies one.';
