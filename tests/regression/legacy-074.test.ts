import { lintSchema } from "@dulja/db";
import { sliceRegression, thinRegression } from "../support/regression";

thinRegression(
  "LEGACY-074",
  "42 of 460 tables have no primary key",
  "packages/db/test/schema-lint.test.ts",
  async ({ db, expect }) => {
    const noPk = await db.admin<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'app' and c.relkind = 'r'
         and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')
       order by c.relname`;
    expect(noPk.map((t) => t.relname)).toEqual([]);
    expect((await lintSchema(db.admin)).filter((v) => v.rule === "id_column")).toEqual([]);
  },
);

sliceRegression(
  "LEGACY-074",
  "42 of 460 tables have no primary key",
  "3A",
  "both tables this slice's posting path writes have a primary key",
  async ({ db, expect }) => {
    const pks = await db.admin<{ relname: string; n: number }[]>`
      select cl.relname, count(c.oid)::int as n
        from pg_class cl
        left join pg_constraint c on c.conrelid = cl.oid and c.contype = 'p'
       where cl.relname in ('inventory_movement', 'stock_on_hand')
       group by cl.relname order by cl.relname`;
    expect(pks).toEqual([
      { relname: "inventory_movement", n: 1 },
      { relname: "stock_on_hand", n: 1 }, // a natural key is still a key
    ]);
  },
);
