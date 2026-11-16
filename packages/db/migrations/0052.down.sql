-- 0052.down.sql — reverse of 0052: delete exactly the code that file inserted and nothing else (§3.6.3).
--
-- PRECONDITION (§3.4.5): this down is reversible only against an UNSEEDED database — which is exactly
-- where §3.4.6's generalised up → down → up reversibility test exercises it. On a seeded database the
-- delete raises 23503 against app.role_permission, whose FK to app.permission(code) has no `on delete`
-- action (plan0A:1325) and whose RI check bypasses RLS. This file cannot remove the grant itself:
-- app.role_permission carries FORCE ROW LEVEL SECURITY and a migration with no tenant context writes zero
-- rows, and app.tenant is guarded the same way, so the migrator cannot even enumerate the tenants to set a
-- context for. The operator therefore removes the per-tenant grants first, as a seed-tier act with
-- set_config('app.tenant_id', <tenant>, false), then runs this down, and re-runs
--   bun run seed --tenant <id> --only roles
-- after re-migrating. Never disable or drop the policy to make this file pass (SAH-027, 041, 053).
-- 0039.down.sql, 0041.down.sql and 0047.down.sql document the identical statement the same way.

-- ── 1. the one 4B code ────────────────────────────────────────────────────────────────────────────────
delete from app.permission where code = 'accounting.bank.reconcile';
