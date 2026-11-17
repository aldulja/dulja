import { sliceRegression, thinRegression } from "../support/regression";
import { postDocument } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7 } from "@dulja/db/test";

thinRegression(
  "LEGACY-050",
  "NULL dimension values make aggregates accumulate orphans and lose all decrements",
  "packages/db/test/schema-lint.test.ts",
  async ({ db, expect }) => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'ledger_entry_dimension' order by column_name`;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(byName["dimension_value_id"]).toBe("NO");
    expect(byName["dimension_type_id"]).toBe("NO"); // a NULL dimension cannot enter the join table at all

    const fks = await db.admin<{ conname: string }[]>`
      select conname from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = 'ledger_entry_dimension' and c.contype = 'f'`;
    expect(fks.length).toBeGreaterThan(0); // and every value is a real row, not free text
  },
);

sliceRegression(
  "LEGACY-050",
  "NULL dimensions accumulate orphans and lose decrements",
  "1A",
  "every ledger line carries a BRANCH dimension; none is NULL and none is orphaned",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "LEGACY050-1A");
    await grantCodes(db, seed, { codes: ["accounting.journal.post"] });
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "legacy050" };
    const doc = await uuidv7(db.admin);
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.document (id, tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id)
               values (${doc}, ${seed.tenant}, ${seed.company}, ${seed.docType}, 'JV', '2026-01-15', 'MYR', ${seed.hq})`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${seed.tenant}, ${seed.company}, ${doc}, 1, ${seed.cash}, 6.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
               values (${seed.tenant}, ${seed.company}, ${doc}, 2, ${seed.sales}, 6.0000)`;
    });
    await withTenant(rw, ctx, (tx) => postDocument(tx, ctx, { documentId: doc }));
    const rows = await withTenant(
      rw,
      ctx,
      (tx) => tx<{ n: number; orphans: number }[]>`
      select count(*)::int as n,
             count(*) filter (where v.id is null)::int as orphans
        from app.ledger_entry l
        join app.ledger_entry_dimension d on d.entry_id = l.id
        left join app.dimension_value v on v.id = d.dimension_value_id
       where l.document_id = ${doc}`,
    );
    expect(rows[0]).toEqual({ n: 2, orphans: 0 });
  },
);

sliceRegression(
  "LEGACY-050",
  "NULL dimension values make aggregates accumulate orphans and lose all decrements",
  "3A",
  "every stock key column is NOT NULL on both the movement and the projection",
  async ({ db, expect }) => {
    const nullable = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app'
         and table_name in ('inventory_movement', 'stock_on_hand')
         and column_name in ('company_id', 'item_id', 'warehouse_id', 'lot_id', 'unit_id')
         and is_nullable = 'YES'
       order by table_name, column_name`;
    // The old system let a movement carry a NULL batch or warehouse; every increment then inserted a fresh
    // orphan row and every decrement matched nothing. The structural answer is ADR 0034's sentinel lot,
    // which is what lets both lot_id columns be NOT NULL rather than "NULL means unbatched".
    expect(nullable).toEqual([]);
  },
);
