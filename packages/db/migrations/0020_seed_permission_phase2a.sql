-- 0020_seed_permission_phase2a.sql — the Phase 2A permission catalogue entry (contracts §3.6.2, spec:2146).
-- app.permission is global (no RLS) and is the one table a migration may write: FORCE ROW LEVEL SECURITY
-- binds app_migrator too (spec:1366), so per-tenant rows — roles, document types, policies — are seed-pack
-- data applied by `bun run seed --tenant` (contracts §3.4.8).

-- ── 1. the Phase 2A catalogue ─────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('accounting.party.manage', 'accounting', true, 'Create, edit and archive customers, vendors and other parties')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
