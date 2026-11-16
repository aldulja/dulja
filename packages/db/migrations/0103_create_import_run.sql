-- 0103_create_import_run.sql — 9B Task 9 (contracts §4.6.1 and §4.2.7 as amended by round 20's C17). The record of one
-- cut-over load started through the API: spec:2206's "bulk endpoints for import/export with async job semantics and a
-- status resource". `POST /v1/companies/{companyId}/imports` writes the row and enqueues `admin.import.run` in ONE
-- transaction; the job claims it under a lease (`packages/db/src/jobs/lease.ts`, 7A/7C's machinery) and records the
-- outcome. `import_batch` (0102) stays the per-key ledger; this table is what a run WAS — who asked, for which date,
-- with which account map, and how it ended — including a dry run, which writes no `import_batch` row at all.
create table app.import_run (
  id              uuid primary key default uuidv7(),          -- the run id every import_batch row of the run carries
  tenant_id       uuid not null references app.tenant(id),
  company_id      uuid not null,
  -- The requesting principal. Stamped by app.stamp_actor: a caller who names someone else is overwritten (§3.3).
  requested_by    uuid not null default app.current_actor() references app.principal(id),
  cut_over_date   date not null,                              -- entered by the operator, never derived (spec:2039)
  dry_run         boolean not null default false,
  -- C14 — the target tables the run is restricted to; NULL is every registered loader.
  only_targets    text[],
  -- The OWNER's legacy → Dulja chart mapping as the request carried it (9B plan N6). It is configuration, not a
  -- record of the books, and the job reads it from here — never from the pg-boss payload, which has no RLS.
  account_map     jsonb,
  status          text not null default 'queued',
  per_loader      jsonb,                                      -- LoadReport.perLoader once done
  skip_count      int,                                        -- rows in the run's skip register once done
  artefact_count  int,                                        -- artefacts the run wrote beside the worker
  started_at      timestamptz,                                -- when the CURRENT claim was taken: the lease's start
  -- Claims taken: the fencing token of a worker's complete and fail writes (lease.ts); a run abandoned
  -- IMPORT_RUN_MAX_CLAIMS times is failed rather than claimed again.
  attempts        smallint not null default 0 check (attempts >= 0),
  finished_at     timestamptz,
  error           text,                                       -- `ERR_<CODE>: detail`, once failed
  created_at      timestamptz not null default now(),
  constraint import_run_status_check check (status in ('queued', 'running', 'done', 'failed')),
  constraint import_run_only_targets_check check (
    only_targets is null or cardinality(only_targets) between 1 and 64),
  constraint import_run_account_map_check check (
    account_map is null or jsonb_typeof(account_map) = 'object'),
  -- A finished run has its counts or an error, never both and never neither.
  constraint import_run_outcome_is_exclusive check (
    (status <> 'done'   or (per_loader is not null and skip_count is not null and error is null))
    and (status <> 'failed' or (error is not null and per_loader is null))),
  constraint import_run_finished_with_status check (
    (finished_at is null) = (status in ('queued', 'running'))),
  constraint import_run_counts_check check (
    (skip_count is null or skip_count >= 0) and (artefact_count is null or artefact_count >= 0)),
  constraint import_run_tenant_id_id_key unique (tenant_id, id),
  -- §3.5.1: a composite FK, because an FK check bypasses RLS.
  foreign key (tenant_id, company_id) references app.company(tenant_id, id)
);

comment on table app.import_run is
  '9B Task 9 — one cut-over load started through the API (spec:2206). At most one queued or running run per company.';

-- SAH-070: the list's keyset order.
create index import_run_company_created_idx on app.import_run (company_id, created_at desc, id desc);
-- ONE live run per company, in the data layer. Two concurrent loads of one company are always an operator error, and
-- the plan's pg-boss singleton key could not say it: a keyed standard job takes a 24-hour slot that a FINISHED job
-- still holds, so a dry run would have refused the real run that follows it the same day.
create unique index import_run_one_live_per_company on app.import_run (company_id)
  where status in ('queued', 'running');

-- §3.5.1 steps 2-4. No branch_isolation: the table has no branch key, and the route's gate is company-wide
-- (admin.company.manage at { company: "path:companyId" }), so a branch-narrowed principal cannot start or read one.
call app_meta.enable_tenant_rls('app.import_run');
call app_meta.attach_audit('app.import_run');
call app_meta.attach_stamp('app.import_run', 'requested_by');
-- No DELETE grant: a run row is the trail of who loaded what into the books (§3.5.4's pinned list is unchanged).
