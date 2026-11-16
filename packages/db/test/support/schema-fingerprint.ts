import type { Sql } from "postgres";

export async function schemaFingerprint(sql: Sql): Promise<string> {
  const parts = await Promise.all([
    sql`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'app' order by 1, 2`,
    sql`select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'app'::regnamespace order by 1, 2`,
    sql`select tablename, indexname, indexdef from pg_indexes where schemaname = 'app' order by 1, 2`,
    sql`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies where schemaname = 'app' order by 1, 2`,
    sql`select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'app'::regnamespace) order by 1, 2`,
    sql`select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef from pg_proc p where p.pronamespace = 'app'::regnamespace order by 1`,
    sql`select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c where c.relnamespace = 'app'::regnamespace and c.relkind in ('r', 'p') order by 1`,
    sql`select t.typname, e.enumlabel, e.enumsortorder from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typnamespace = 'app'::regnamespace order by 1, 3`,
    sql`select table_name, privilege_type from information_schema.role_table_grants where grantee = 'app_rw' and table_schema = 'app' order by 1, 2`,
  ]);
  return JSON.stringify(parts);
}
