-- ── 0074. app.report_definition — the report builder's stored definition ───────
-- contracts §4.11.2. spec:1240 wants an end-user report designer that is "text-defined, diffable,
-- version-controlled"; spec:1246 puts "Delphi-serialised report files" on the explicit do-NOT-carry-over
-- list and LEGACY-077 is the defect that follows from them (report definitions as MEMO blobs in customer
-- databases, so no static analysis can ever tell whether a procedure is live). A definition here is
-- validated JSON seeded from a version-controlled file, and a tenant's edit is a NEW version row.

-- ── 1. the table ──────────────────────────────────────────────────────────────
create table app.report_definition (
  id           uuid primary key default uuidv7(),
  tenant_id    uuid not null references app.tenant(id),
  company_id   uuid not null,
  code         text not null,                                  -- the §4.16.1 register; grammar checked in TypeScript
  version      int  not null,                                  -- a tenant edit is a new version, never an in-place rewrite
  definition   jsonb not null,                                 -- validated against packages/domain/report-definition.schema.json
  cloned_from  uuid,                                           -- the row this one was cloned from (the DoD's clone-and-edit)
  is_core      boolean not null default false,                 -- true = seeded from the pack; false = a tenant's own
  archived_at  timestamptz,                                    -- archived, never deleted (spec:2049)
  created_at   timestamptz not null default now(),
  constraint report_definition_version_check check (version > 0),   -- 2C's precedent on print_template.version (§4.5.9)
  constraint report_definition_company_id_code_version_key unique (company_id, code, version),
  constraint report_definition_tenant_id_id_key unique (tenant_id, id),
  -- Composite FKs: an FK check bypasses RLS, so a plain references app.company(id) would let tenant A's
  -- definition point at tenant B's company if the uuid were known (§3.5.1).
  foreign key (tenant_id, company_id)  references app.company(tenant_id, id),
  foreign key (tenant_id, cloned_from) references app.report_definition(tenant_id, id)
);

-- ── 2. the index the definition list and the run route filter on ──────────────
-- LEGACY-070: index coverage was thin on exactly the columns reports filter by. Every read of this table is
-- "the live definitions of this company for this code", so the index carries all three and excludes archived rows.
create index report_definition_lookup_idx on app.report_definition (company_id, code, version desc)
  where archived_at is null;

-- ── 3. tenancy, audit ─────────────────────────────────────────────────────────
call app_meta.enable_tenant_rls('app.report_definition');   -- spec:106: enables AND forces RLS; policy named tenant_isolation
call app_meta.attach_audit('app.report_definition');        -- spec:106: §3.5.3 grants this table no AUDIT_EXEMPT membership
-- app_rw receives select, insert, update through app_migrator's default privileges (0001 §9) — no grant
-- statement here. No DELETE: §3.5.4's pinned list is unchanged by this slice, and archival is archived_at.
-- No attach_stamp: the table has no *_by column (§3.3).
