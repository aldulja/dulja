-- Refuse reversal when existing per-tenant grants still reference these codes.
delete from app.permission where code in ('pos.shift.close_any', 'pos.report.read');
