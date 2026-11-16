-- Global permission catalogue; per-tenant grants belong to the role seed.
insert into app.permission (code, module, mutating, description) values
  ('pos.shift.close_any', 'pos', true, 'Close a shift opened by another principal'),
  ('pos.report.read', 'pos', false, 'Read POS Z-report, shift history and sales by cashier')
on conflict (code) do update set module=excluded.module, mutating=excluded.mutating, description=excluded.description;
