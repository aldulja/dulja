import { thinRegression } from "../support/regression";

thinRegression(
  "LEGACY-075",
  "Deployment template placeholders were never substituted in shipped objects",
  "packages/db/test/privileges.test.ts",
  async ({ db, expect }) => {
    const objects = await db.admin<{ kind: string; name: string }[]>`
      select 'relation' as kind, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('app', 'app_meta') and c.relkind in ('r', 'v', 'i', 'S')
      union all
      select 'routine', p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('app', 'app_meta')`;
    expect(objects.filter((o) => /%|\$\{|<name>/i.test(o.name))).toEqual([]);

    const bodies = await db.admin<{ proname: string }[]>`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('app', 'app_meta') and p.prosrc like '%"%Name%"%'`;
    expect(bodies).toEqual([]);

    // Every object states its own identity, so grepping a name finds the definition and not only the call sites.
    expect(objects.every((o) => /^[a-z][a-z0-9_]*$/.test(o.name) || o.kind === "relation")).toBe(
      true,
    );
  },
);
