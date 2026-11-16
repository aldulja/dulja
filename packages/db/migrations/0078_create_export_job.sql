-- ── 0078. app.export_job ─────────────────────────────────────────────────────────────────────────────
-- spec:2186 "Data export at any time (v1 — it is your own books), unprompted, in open formats
-- (CSV + JSON + a documented schema)"; spec:2206 "Bulk endpoints for import/export with async job
-- semantics and a status resource"; spec:2211 right-to-export. Contracts §4.6.1 + 7C amendment A9 (round 15).
create table app.export_job (
  id                  uuid primary key default uuidv7(),
  tenant_id           uuid not null references app.tenant(id),
  company_id          uuid not null,
  -- The requesting principal. Stamped by app.stamp_actor: a caller who names someone else is overwritten
  -- (§3.3), which is what makes "every export is attributable" true (test 13).
  requested_by        uuid not null default app.current_actor() references app.principal(id),
  -- Three values, not two: spec:2186 requires CSV *and* JSON *and* a schema, which a two-value vocabulary
  -- cannot express. 'both' is the default (amendment A9).
  format              text not null default 'both',
  status              text not null default 'queued',
  -- The requester's attachment authority, RESOLVED AT REQUEST TIME. The job runs as the tenant's system
  -- principal (spec:2179, hazard 20) and holds every code, so it cannot re-derive this and must not try;
  -- MODULE_READ_CODE lives in apps/api and packages/{db,worker} may not import an app (§3.1, §4.5.8).
  -- ADR 0070 records the decision.
  readable_modules    text[] not null default '{}',
  -- §4.5.8 gates a LOT attachment on inventory.item.read while the module read code for 'inventory' is
  -- inventory.stock.read — two different codes, so two different facts.
  lot_attachments     boolean not null default false,
  include_attachments boolean not null default true,
  table_count         int,
  row_count           bigint,
  byte_size           bigint,
  object_key          text,          -- '<tenant_id>/exports/<export_job_id>.tar.gz' (SAH-038: server-generated)
  sha256              bytea,         -- of the archive bytes
  manifest            jsonb,
  started_at          timestamptz,   -- when the CURRENT claim was taken: the lease's start (Phase 7 review)
  -- Claims taken (Phase 7 review, finding 2, amended in place: 0078 has never been applied outside a test
  -- database). It fences a superseded worker's writes, and a job abandoned EXPORT_JOB_MAX_CLAIMS times is
  -- failed rather than claimed again (packages/db/src/export/store.ts).
  attempts            smallint not null default 0 check (attempts >= 0),
  finished_at         timestamptz,
  error               text,
  created_at          timestamptz not null default now(),
  constraint export_job_format_check check (format in ('csv', 'json', 'both')),
  constraint export_job_status_check check (status in ('queued', 'running', 'done', 'failed')),
  -- A finished job has an artefact or an error, never both and never neither.
  constraint export_job_outcome_is_exclusive check (
    (status <> 'done'   or (object_key is not null and sha256 is not null and error is null))
    and (status <> 'failed' or (error is not null and object_key is null))),
  constraint export_job_finished_with_status check (
    (finished_at is null) = (status in ('queued', 'running'))),
  -- Every module name the array may hold is one of the FIVE permission modules of §3.6.1's closed CHECK
  -- (admin, accounting, inventory, hr, pos).
  constraint export_job_readable_modules_closed check (
    readable_modules <@ array['admin', 'accounting', 'inventory', 'hr', 'pos']::text[]),
  constraint export_job_object_key_key unique (object_key),   -- two jobs never claim one artefact (ADR 0067's rule)
  constraint export_job_tenant_id_id_key unique (tenant_id, id),
  -- §3.5.1: a composite FK, because an FK check bypasses RLS.
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

-- SAH-070: the list's keyset order, and the worker's pick-up read.
create index export_job_company_created_idx on app.export_job (company_id, created_at desc, id desc);
create index export_job_queued_idx on app.export_job (company_id) where status = 'queued';

-- §3.5.1 steps 2-4. No branch_isolation: the table has no branch key — an export is company-wide by
-- construction and a branch-narrowed principal cannot request one at all (the route's gate is
-- { company: "path:companyId" }, test 36).
call app_meta.enable_tenant_rls('app.export_job');               -- spec:106: enables AND forces RLS
call app_meta.attach_audit('app.export_job');                    -- spec:106: no AUDIT_EXEMPT membership (§3.5.3)
call app_meta.attach_stamp('app.export_job', 'requested_by');   -- §3.5.1 step 4
-- No DELETE grant: a job row is the audit trail of who exported what (§3.5.4's pinned list is unchanged).
