-- ── 0075. app.saved_view and app.report_run ───────────────────────────────────
-- contracts §4.11.2, ADR 0067. A saved view is a named parameter set over a definition — spec:1241's "an
-- accountant filters a ledger and wants that exact view back from a bookmark", persisted server-side so the
-- bookmark survives a new machine. A report run is the async status resource spec:2206 requires for a bulk render.

-- ── 1. saved_view — archived, never deleted (spec:2049) ───────────────────────
create table app.saved_view (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  report_definition_id uuid not null,
  name_en              text not null,                          -- bilingual labels as columns, not a blob (spec:2045)
  name_ar              text,
  parameters           jsonb not null default '{}'::jsonb,     -- the definition's parameter names → entered values
  -- owner_principal_id, NOT owner_by: this records WHOM the view belongs to, which is data. A *_by name would
  -- attract app.stamp_actor and silently replace the owner with the acting principal (§3.3, LEGACY-044 inverted).
  owner_principal_id   uuid not null default app.current_actor() references app.principal(id),
  shared               boolean not null default false,         -- visible to every principal of the company
  archived_at          timestamptz,                            -- spec:2049: archived, never deleted
  created_at           timestamptz not null default now(),
  constraint saved_view_tenant_id_id_key unique (tenant_id, id),
  -- §3.5.1: composite FKs, because an FK check bypasses RLS.
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  foreign key (tenant_id, report_definition_id) references app.report_definition(tenant_id, id)
);
-- LEGACY-070: the columns the list filters by — "my views" and "the company's shared views of this definition".
create index saved_view_owner_idx on app.saved_view (company_id, owner_principal_id)
  where archived_at is null;
create index saved_view_shared_idx on app.saved_view (company_id, report_definition_id)
  where archived_at is null and shared;

call app_meta.enable_tenant_rls('app.saved_view');   -- spec:106: enables AND forces RLS; policy named tenant_isolation
call app_meta.attach_audit('app.saved_view');        -- spec:106: no AUDIT_EXEMPT membership (§3.5.3)
-- No DELETE grant. spec:2049 admits genuine deletion only for drafts and the erasure workflow, and a saved
-- view is neither, so §3.5.4's pinned five-row list is unchanged (hazard 25). No attach_stamp: no *_by column.

-- ── 2. report_run — the async status resource (spec:2206) ─────────────────────
create table app.report_run (
  id                   uuid primary key default uuidv7(),
  tenant_id            uuid not null references app.tenant(id),
  company_id           uuid not null,
  report_definition_id uuid not null,
  saved_view_id        uuid,                                   -- null = ad-hoc parameters
  parameters           jsonb not null default '{}'::jsonb,
  format               text not null check (format in ('pdf','xlsx','csv')),   -- §4.11.2's three renderers
  lang                 char(2) not null check (lang in ('en','ar')),          -- @dulja/i18n's two locales (0E)
  status               text not null default 'queued' check (status in ('queued','running','done','failed')),
  requested_by         uuid not null default app.current_actor() references app.principal(id),   -- stamped (§3.3)
  object_key           text,                                   -- '<tenant_id>/reports/<run_id>.<ext>' (LEGACY-038: server-generated)
  sha256               bytea,                                  -- of the rendered bytes
  -- The claim's lease (Phase 7 review, finding 2, amended in place: 0075 has never been applied outside a test
  -- database). `started_at` is when the CURRENT claim was taken; a `running` row whose claim is older than the
  -- lease (REPORT_RUN_LEASE_SECONDS, packages/db/src/reports/run-store.ts) belonged to a worker that died, and a
  -- redelivered job may reclaim it. `attempts` counts claims: it fences a superseded worker's writes, and a run
  -- abandoned REPORT_RUN_MAX_CLAIMS times is failed rather than claimed again.
  started_at           timestamptz,
  attempts             smallint not null default 0 check (attempts >= 0),
  finished_at          timestamptz,
  error                text,                                   -- the problem code and detail on 'failed'
  created_at           timestamptz not null default now(),
  constraint report_run_object_key_key unique (object_key),   -- ADR 0067: two runs never claim one artefact
  constraint report_run_tenant_id_id_key unique (tenant_id, id),
  -- ADR 0067: done implies an artefact; failed implies a reason. Without these a run could report success with
  -- nothing to download, which is the class of defect LEGACY-084 describes on the error side.
  constraint report_run_done_has_artefact check (status <> 'done' or (object_key is not null and sha256 is not null)),
  constraint report_run_failed_has_error  check (status <> 'failed' or error is not null),
  foreign key (tenant_id, company_id)           references app.company(tenant_id, id),
  foreign key (tenant_id, report_definition_id) references app.report_definition(tenant_id, id),
  foreign key (tenant_id, saved_view_id)        references app.saved_view(tenant_id, id)
);
create index report_run_recent_idx on app.report_run (company_id, created_at desc);   -- LEGACY-070: the list's sort key
create index report_run_queued_idx on app.report_run (company_id, status)             -- LEGACY-070: the worker's pick-up read
  where status in ('queued','running');

call app_meta.enable_tenant_rls('app.report_run');                -- spec:106
call app_meta.attach_audit('app.report_run');                     -- spec:106
call app_meta.attach_stamp('app.report_run', 'requested_by');    -- §3.5.1 step 4: every *_by column gets its trigger
-- No DELETE grant: a run row is the audit trail of who exported what and is never removed (ADR 0067).
