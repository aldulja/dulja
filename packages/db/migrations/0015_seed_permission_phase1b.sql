-- ── 1. Phase 1B permission catalogue ───────────────────────────────────────────
-- app.permission is GLOBAL (no tenant_id, no RLS — 0001 §4) and is therefore the one kind of
-- row a migration may write: FORCE ROW LEVEL SECURITY binds app_migrator too, so per-tenant rows
-- are seed-pack data instead (contracts §3.4.8, spec:1366).
-- One code: the read gate on accounting.trial_balance and accounting.ledger (§4.16.1, spec:2147).
insert into app.permission (code, module, mutating, description) values
  ('accounting.report.read', 'accounting', false,
   'Read accounting reports: trial balance and ledger (spec:2300 minimal set, Phase 1)')
on conflict (code) do update
  set module      = excluded.module,
      mutating    = excluded.mutating,
      description = excluded.description;
