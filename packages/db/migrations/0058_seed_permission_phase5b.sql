-- 0058 — slice 5B's permission code.
-- §3.6.3: app.permission is GLOBAL (no RLS, read-only for app_rw), so it is migration data and not
-- seed-pack data (§3.4.8, hazard 10). The upsert is `do update` so a re-run corrects a description.
-- spec:2147 names accounting.tax.file in the v1 catalogue; §3.6.2 assigns it to slice 5B.
insert into app.permission (code, module, mutating, description) values
  ('accounting.tax.file', 'accounting', true,
   'Submit, poll and cancel e-invoice transmissions to the fiscalisation authority')
on conflict (code) do update
  set module      = excluded.module,
      mutating    = excluded.mutating,
      description = excluded.description;
