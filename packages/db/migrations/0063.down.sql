-- packages/db/migrations/0063.down.sql
-- Deletes exactly the three codes 0063 inserted, then reverses its item tax selection (section 0), and
-- nothing else.
--
-- ⚠️ THIS FILE CANNOT REMOVE THE ROLE GRANTS IT ORPHANS, AND THAT IS A PROPERTY OF THE SCHEMA, NOT AN
--    OMISSION. Three facts, each verifiable:
--      1. `app.role_permission.permission_code references app.permission(code)` has NO `on delete` action
--         (plan0A:1325 -- the default is NO ACTION), and referential-integrity checks bypass RLS, so a
--         `role_permission` row naming one of these three codes makes the delete below raise SQLSTATE 23503.
--      2. The grants cannot be deleted from here. `app.role_permission` carries FORCE ROW LEVEL SECURITY
--         (plan0A:1329 via `app_meta.enable_tenant_rls`, whose body forces RLS "for the table owner too"),
--         and §3.4.8 states the consequence: "a migration file with no set_config sees zero tenants and
--         cannot write them". A `delete from app.role_permission` here would silently affect ZERO rows.
--      3. Nor can this file discover the tenants to set a context FOR: `app.tenant` is itself forced with
--         `using (id = app.current_tenant())` (plan0A:980-981), so the migrator enumerating it sees nothing.
--    Disabling or dropping the policy "temporarily" is forbidden outright (Global Constraint 1; SAH-027,
--    041, 053), so the down file does the one thing it legitimately can and the ROLLBACK CARRIES A
--    PRECONDITION instead: it is exercised on a freshly migrated database with no seeded tenant -- exactly
--    where §3.4.6's generalised reversibility test exercises every down file -- and on a database where
--    `bun run seed --tenant <id> --only roles` has run, the operator removes the grants per tenant first
--    (a seed-tier act, with `set_config('app.tenant_id', ...)`) and re-runs `--only roles` after
--    re-migrating. T4 Step 8 states the precondition on the command. 6A's `0062.down.sql` (6A:1824-1828)
--    has the identical shape for its eleven codes; the general rule belongs in §3.4.5 (Known gaps #8).
delete from app.permission
 where code in ('pos.price.check', 'pos.shift.own', 'pos.attendance.clock');

-- ── 0. item tax selection, in reverse ──────────────────────────────────────────────────────────────────
-- The index, then the key, then the column. Dropping the column would take both with it; each is named so
-- the down states exactly what the up created.
drop index if exists app.item_tax_code_idx;
alter table app.item drop constraint item_tax_code_fk;
alter table app.item drop column tax_code_id;
