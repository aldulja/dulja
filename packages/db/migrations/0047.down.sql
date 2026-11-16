-- Reverse of 0047: exactly the seven codes it inserted and nothing else (contracts §3.6.3).
-- app.role_permission.permission_code references app.permission(code) with NO `on delete cascade`
-- (plan0A:1325), so this delete is BLOCKED while any tenant still grants one of the seven — which is the
-- correct signal, not a defect: re-run that tenant's role seed first (contracts §3.4.5). 0039.down.sql and
-- 0041.down.sql document the identical statement the same way.

-- ── 1. the seven 4A codes ─────────────────────────────────────────────────────────────────────────────
delete from app.permission where code in (
  'accounting.sales.post',
  'accounting.receipt.create',
  'accounting.receipt.post',
  'accounting.payment.create',
  'accounting.payment.approve',
  'accounting.payment.post',
  'accounting.credit_limit.override'
);
