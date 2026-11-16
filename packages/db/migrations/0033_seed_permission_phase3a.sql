-- 0033_seed_permission_phase3a.sql — the five Phase 3A inventory codes (spec:2148, contracts §3.6.2).
-- app.permission is the one table a migration may write: it is global (no tenant_id, no RLS — plan0A:1313),
-- so FORCE ROW LEVEL SECURITY does not hide it from app_migrator the way it hides every per-tenant table
-- (contracts §3.4.8, spec:1366, hazard 10). The role grants over these codes are per-tenant seed-pack data
-- and are applied by `bun run seed --tenant <id> --only roles` from packages/db/seed/roles.ts.
-- `do update` rather than `do nothing`: re-running on staging must correct a drifted description.
-- This file's version is higher than 0030-0032, which land in later tasks. That is expected and legal:
-- hazard 14 — no plan asserts max(version), and the runner applies whatever is not in listApplied().

-- ── 1. the Phase 3A catalogue ─────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('inventory.item.read',               'inventory', false, 'Read the item master, units, unit conversions, warehouses and lots, and download a lot''s attachments'),
  ('inventory.item.manage',             'inventory', true,  'Create, edit and archive items, units, unit conversions and warehouses — the head-office catalogue'),
  ('inventory.price.manage',            'inventory', true,  'Create and edit price lists, their lines and promotions'),
  ('inventory.stock.read',              'inventory', false, 'Read stock on hand per item, warehouse and lot, and download an inventory document''s attachments'),
  ('inventory.negative_stock.override', 'inventory', true,  'As a second principal, authorise one document to take stock below zero; recorded as an override document_event')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
