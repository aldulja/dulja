-- 0062.down.sql — deletes exactly the codes the up inserted (§3.6.3).
--
-- PRECONDITION (contracts §3.4.5): this down is reversible only against an UNSEEDED database.
-- It deletes the eleven catalogue rows and deliberately does NOT touch the role grants that the seed tier
-- (packages/db/seed/roles.ts, applied by `seed --only roles`) holds for those codes,
-- because it cannot: (1) app.role_permission.permission_code references app.permission(code) with no
--     `on delete` action, and referential-integrity checks bypass RLS — so on a database where
--     `--only roles` has run, this delete does not silently orphan a grant, it RAISES SQLSTATE 23503;
-- (2) a `delete from app.role_permission` here would affect ZERO rows anyway — app_meta.enable_tenant_rls
--     applies FORCE ROW LEVEL SECURITY, which binds the table owner too, and a migration sets no
--     app.tenant_id (§3.4.8);
-- (3) nor can this file discover the tenants to set a context FOR — app.tenant is itself forced with
--     `using (id = app.current_tenant())`, so the migrator enumerating it sees nothing.
-- The operator, not this file, removes the grants per tenant first (a seed-tier act, under
-- `set_config('app.tenant_id', …)`), and re-runs `bun run seed --tenant <id> --only roles` after
-- re-migrating. NEVER disable or drop the policy to make this file "work" — LEGACY-027, LEGACY-041, LEGACY-053.
delete from app.permission where code in (
  'admin.terminal.manage','pos.sync.pull','pos.sync.push','pos.ticket.sell','pos.ticket.discount',
  'pos.ticket.return','pos.ticket.return_blind','pos.ticket.void','pos.ticket.override',
  'pos.needs_attention.resolve','pos.customer.create');
