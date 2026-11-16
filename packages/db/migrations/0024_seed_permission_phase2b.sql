-- 0024_seed_permission_phase2b.sql — the Phase 2B permission catalogue entry (contracts §3.6.2, spec:2146).
-- app.permission is a GLOBAL catalogue with no RLS and read-only for app_rw, so it is migration data; role
-- grants are per-tenant seed-pack data applied by `bun run seed --tenant <id> --only roles` (contracts §3.4.8,
-- hazard 10).

-- ── 1. the Phase 2B catalogue ─────────────────────────────────────────────────────────────────────────
insert into app.permission (code, module, mutating, description) values
  ('accounting.document.reverse', 'accounting', true,
   'Reverse a posted document, producing the reversing document its policy names (D13, spec:2024)')
on conflict (code) do update
  set module = excluded.module, mutating = excluded.mutating, description = excluded.description;
