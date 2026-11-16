-- 0004_create_pgboss_schema.sql — the job queue's home (contracts §4.2.6).
-- spec §3.2.2: pg-boss is Postgres-backed "so a job is enqueued in the same transaction as the posting — the
-- guarantee SAH-005 lacked". pg-boss owns its own tables; app_rw may not create objects (spec §3.8, task 0.2), so
-- this file creates the schema and its default privileges and `bun run --cwd apps/worker jobs:install` installs
-- pg-boss's tables as app_migrator at deploy time — the same class of tooling as the migration runner, never
-- application code (spec §0.2 "no DDL from application code", SAH-053).

-- ── 1. the schema ─────────────────────────────────────────────────────────────
create schema pgboss;
comment on schema pgboss is 'pg-boss job queue (contracts §4.2.6). Tables installed by apps/worker jobs:install as app_migrator.';
grant usage on schema pgboss to app_rw;
-- deliberately NO `grant create`: the runtime role never issues DDL.

-- ── 2. default privileges, before any table exists ───────────────────────────
-- ALTER DEFAULT PRIVILEGES applies only to objects created AFTER it runs, so it must precede both
-- pgboss.tenant_registry below and pg-boss's own installation.
alter default privileges for role app_migrator in schema pgboss grant select, insert, update, delete on tables to app_rw;
alter default privileges for role app_migrator in schema pgboss grant usage, select on sequences to app_rw;

-- ── 3. the tenant registry ───────────────────────────────────────────────────
-- A scheduled job runs with no tenant set, and FORCE ROW LEVEL SECURITY binds app_migrator too (spec §3.8), so no
-- role can list app.tenant without one. This table — outside schema app, outside RLS, and therefore outside the
-- 0.4 schema linter, which scans relnamespace = 'app'::regnamespace — is the list a scheduled handler iterates.
-- It is written by `bun run seed --tenant <id>` (0C) and by nothing else.
create table pgboss.tenant_registry (
  tenant_id   uuid primary key,
  created_at  timestamptz not null default now()
);
comment on table pgboss.tenant_registry is 'contracts §4.2.6 — the tenants a scheduled job iterates; written by the seed CLI (0C).';
