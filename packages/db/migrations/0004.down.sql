-- 0004.down.sql — reverse dependency order (§3.4.5).
-- The default-privilege revokes must precede the drop: a DROP SCHEMA leaves pg_default_acl rows behind otherwise,
-- and the up → down → up fingerprint test (§3.4.6) would then see a schema that is not byte-identical.
alter default privileges for role app_migrator in schema pgboss revoke usage, select on sequences from app_rw;
alter default privileges for role app_migrator in schema pgboss revoke select, insert, update, delete on tables from app_rw;
-- CASCADE because pg-boss's own tables were installed into this schema after the migration ran (§3.4.5).
drop schema if exists pgboss cascade;
