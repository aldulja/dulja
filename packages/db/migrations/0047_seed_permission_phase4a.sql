-- 0047_seed_permission_phase4a.sql — slice 4A. The seven permission codes of contracts §3.6.2, spec:2147.
-- app.permission is global (no tenant_id, no RLS, read-only for app_rw — plan0A:1313), so FORCE ROW LEVEL
-- SECURITY does not hide it from app_migrator the way it hides every per-tenant table: this is migration
-- data, not seed-pack data (contracts §3.4.8, spec:1366, hazard 10). The role grants over these codes are
-- per-tenant seed-pack data and are applied by `bun run seed --tenant <id> --only roles` from
-- packages/db/seed/roles.ts.
-- All seven are `mutating`, so R7 (spec:2178) gives the auditor none of them.
-- This file's version is higher than 0045-0046, which land in later tasks of this same slice. That is
-- expected and legal: hazard 14 — no plan asserts max(version), and the runner applies whatever is not in
-- listApplied() in version order (contracts §3.4.1).

-- ── 1. the seven codes §3.6.2 assigns 4A ──────────────────────────────────────────────────────────────
-- spec:2147 "receipts (money in) need no maker-checker, payments (money out) do", which is why receipt and
-- payment carry separate .create/.approve/.post codes; spec:2179 is what accounting.credit_limit.override
-- serves. The descriptions are packages/contracts/permissions.ts's own strings, character for character.
-- `on conflict do update` and not `do nothing`: §3.6.3 makes the catalogue bidirectional, so a description
-- drifting between the module and the table is corrected by re-running the migration on staging.
insert into app.permission (code, module, mutating, description) values
  ('accounting.sales.post',            'accounting', true,
   'Post sales invoices and sales credit notes'),
  ('accounting.receipt.create',        'accounting', true,
   'Create and submit receipts — money in'),
  ('accounting.receipt.post',          'accounting', true,
   'Post receipts — money in, no maker-checker (spec:2147)'),
  ('accounting.payment.create',        'accounting', true,
   'Draft a payment — money out; incompatible with accounting.payment.approve (R6)'),
  ('accounting.payment.approve',       'accounting', true,
   'Approve a payment drafted by another principal (R1, R6)'),
  ('accounting.payment.post',          'accounting', true,
   'Post an approved payment — money out'),
  ('accounting.credit_limit.override', 'accounting', true,
   'Record a credit-limit override on one document as a second principal (spec:2179)')
on conflict (code) do update
   set module      = excluded.module,
       mutating    = excluded.mutating,
       description = excluded.description;
