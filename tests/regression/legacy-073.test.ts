import { lintSchema } from "@dulja/db";
import { itemLoader, lotLoader } from "@dulja/importer";
import { sliceRegression, thinRegression } from "../support/regression";
import { loadFromCorpus } from "../invariants/support/cut-over";

thinRegression(
  "LEGACY-073",
  "Referential integrity is enforced inconsistently for the same logical relationship",
  "packages/db/test/schema-lint.test.ts",
  async ({ db, expect }) => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.rule === "composite_fk")).toEqual([]);
    // Every tenant-scoped reference is the composite (tenant_id, x) form, so the same logical relationship is
    // enforced the same way everywhere; only tenant, principal and permission take a plain FK (contracts §4.1).
    expect(violations).toEqual([]);
  },
);

sliceRegression(
  "LEGACY-073",
  "Referential integrity enforced inconsistently for the same logical relationship",
  "3A",
  "every tenant-scoped parent of a movement is reached by a COMPOSITE (tenant_id, x) foreign key",
  async ({ db, expect }) => {
    const fks = await db.admin<{ ref: string; cols: string[] }[]>`
      select rf.relname as ref, array_agg(a.attname order by k.ord) as cols
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class rf on rf.oid = c.confrelid
        join unnest(c.conkey) with ordinality k(attnum, ord) on true
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
       where c.contype = 'f' and cl.relname = 'inventory_movement'
       group by c.oid, rf.relname
       order by rf.relname`;
    // company, document, item, warehouse, lot and unit_of_measure are all reached as (tenant_id, x); only
    // app.tenant and app.principal are plain, which §4.1 permits. One shape for one relationship.
    for (const fk of fks) {
      if (fk.ref === "tenant" || fk.ref === "principal") {
        expect(fk.cols).toHaveLength(1);
        continue;
      }
      expect(fk.cols[0], fk.ref).toBe("tenant_id");
      expect(fk.cols, fk.ref).toHaveLength(2);
    }
    expect(fks.map((f) => f.ref)).toContain("lot");
  },
);

sliceRegression(
  "LEGACY-073",
  "Orphaned references (Job 82%, CostCentre 81% unconstrained)",
  "9B",
  "an orphaned legacy batch or material is reported as a skip with its reason, never loaded with a null parent",
  async ({ expect }) => {
    // The resolver answers what a LOAD recorded in app.import_batch; a parent that was never imported answers null.
    const nothing = { byLegacyRef: async () => null };
    expect(
      await lotLoader.map(
        { BATID: "9001", BATMAT: "999", BATCODE: "B-ORPHAN", BATEXPIRY: null, BATMFG: null },
        nothing,
      ),
    ).toEqual({ skip: "material 999 has no imported item; the batch is an orphan (LEGACY-073)" });
    expect(
      await itemLoader.map(
        { MATID: "13", MATCODE: "LOOSE", MATNAME: "Loose", MATUNIT: "77" },
        nothing,
      ),
    ).toEqual({
      skip: "material 13 references unit 77, which has no imported unit_of_measure; the item is an orphan (LEGACY-073)",
    });
  },
);

// 9B Task 5 — the same rule through the whole registered load (`loadFromCorpus`, contracts §4.17.1): the committed
// cut-over corpus's orphaned batch reaches the run's skip register with its reason, and nothing else of the lot loader
// does. It reads only the skip register, the one case the self-contained one-argument form is for.
sliceRegression(
  "LEGACY-073",
  "Orphaned references (Job 82%, CostCentre 81% unconstrained)",
  "9B",
  "the whole cut-over load reports the corpus's orphaned batch, with its reason, and loads no null parent",
  async ({ expect }) => {
    const skips = await loadFromCorpus("cut-over");
    expect(skips.filter((k) => k.loader === "lot")).toEqual([
      {
        loader: "lot",
        sourceTable: "MATBATCHES",
        sourceKey: "9001",
        reason: "material 999 has no imported item; the batch is an orphan (LEGACY-073)",
      },
    ]);
  },
);
