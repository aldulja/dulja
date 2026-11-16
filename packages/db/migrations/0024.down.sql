-- Reverse of 0024: exactly the one code it inserted. Reversible only against an unseeded database — the FK
-- from app.role_permission.permission_code blocks the delete while any tenant still grants the code; re-run
-- `bun run seed --tenant <id> --only roles` for that tenant first (contracts §3.4.5).
delete from app.permission where code = 'accounting.document.reverse';
