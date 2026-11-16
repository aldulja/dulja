-- 0062_seed_permission_phase6a.sql
-- §4.2.1's pos and admin catalogues (spec:2150) · contracts §3.6.2 (the 6A rows) · §3.4.8 (app.permission is
-- GLOBAL and is therefore migration data; roles and grants are seed-pack data and are not here).
insert into app.permission (code, module, mutating, description) values
  ('admin.terminal.manage',      'admin', true,  'Issue and revoke POS terminal enrolments'),
  ('pos.sync.pull',              'pos',   false, 'Pull the branch catalogue to a terminal'),
  ('pos.sync.push',              'pos',   true,  'Push a ticket batch from a terminal'),
  ('pos.ticket.sell',            'pos',   true,  'Sell at a till'),
  ('pos.ticket.discount',        'pos',   true,  'Discount a line or a ticket within the branch limit'),
  ('pos.ticket.return',          'pos',   true,  'Return against an original ticket'),
  ('pos.ticket.return_blind',    'pos',   true,  'Return with no original ticket'),
  ('pos.ticket.void',            'pos',   true,  'Void a ticket'),
  ('pos.ticket.override',        'pos',   true,  'Authorise, as a second principal, a ticket beyond a cashier''s limit'),
  ('pos.needs_attention.resolve','pos',   true,  'Resolve a refused ticket in the shop queue'),
  ('pos.customer.create',        'pos',   true,  'Quick-create a customer at a till')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
