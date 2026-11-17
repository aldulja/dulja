-- packages/db/migrations/0063_alter_item_seed_permission_phase6b.sql
-- Two things, both slice 6B's (Plan Contracts, "6B pricing prerequisite reconciliation", 2026-10-08, which
-- replaces A10's stale ownership and gives this file its long name):
--   0. the item's default tax selection the till prices with, and
--   1. the three permission codes §3.6.2 assigns slice 6B.
--
-- The codes are evaluated ONLY at the till, from the down-synced `pos_cashier.snapshot` (§4.6.3), which is
-- why §3.6.3 makes `apps/pos` one of the roots the `permission-catalogue` lint scans: a code with no
-- reference anywhere fails the build (spec:2051's inverse of LEGACY-084), and these three have their only
-- references in the till.
--
-- `app.permission` is GLOBAL (no RLS, read-only to app_rw — plan0A:1254), so it is migration data and not
-- seed-pack data (§3.4.8, hazard 10). Per-tenant rows -- the role grants -- are `packages/db/seed/roles.ts`.

-- ── 0. item tax selection ──────────────────────────────────────────────────────────────────────────────
-- Additive and nullable: every existing item deliberately remains untaxed (explicit null is "untaxed" at the
-- till, A10), and no historical document changes. The key is TENANT-COMPOSITE (§3.5.1, as 0055's
-- `document_line_tax_code_fk`), so an item can never name another tenant's tax code. Whether the code is the
-- item's own company's, active and effective is the item service's check (A10), not a constraint's.
alter table app.item add column tax_code_id uuid;
alter table app.item add constraint item_tax_code_fk foreign key (tenant_id, tax_code_id) references app.tax_code (tenant_id, id);
-- The reconciliation's "index for non-null references": the FK's check on a tax-code delete and every
-- lookup of the items carrying a code read it. Partial, as 0055's `document_line_tax_code_idx`, so the many
-- untaxed items cost nothing.
create index item_tax_code_idx on app.item (tax_code_id) where tax_code_id is not null;

-- ── 1. the three codes ────────────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  -- spec:1355 "Price check -- a read-only lookup mode (the old system shipped this as a separate
  -- PriceChecker.exe; here it is a mode of the same app)". Read-only, so `mutating` is false.
  ('pos.price.check',      'pos', false, 'Look up an item price at a till without starting a sale'),
  -- spec:1352 "Shift -- open/close with declared opening float, cash count at close". `own` is in the
  -- action vocabulary of §3.6.1 (the C2 resolution added it); `pos.shift.close_any` is 6D's separate code
  -- for closing SOMEONE ELSE'S shift, which is a branch-manager act and not this one.
  ('pos.shift.own',        'pos', true,  'Open and close one''s own till shift'),
  -- spec:2089, §3.7.6's Staff row: "clock-in/out recorded as attendance_event for HR (§3.10)". The
  -- back-office correction code is `hr.attendance.record` and is 6C's -- a different act by a different
  -- person, which is why they are two codes.
  ('pos.attendance.clock', 'pos', true,  'Clock in and out at a till')
on conflict (code) do update set
  module = excluded.module, mutating = excluded.mutating, description = excluded.description;

