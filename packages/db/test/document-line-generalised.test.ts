import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedItem, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.document_line generalised — contracts §4.3.4 (2A row), spec:1185", () => {
  let db: Db;
  let a: Seed;
  let doc: string;
  // 3A's 0032 added document_line_item_fk, so the arbitrary uuid this file used to write into item_id is
  // now a 23503 (assumption 10). One real item stands in for it, and every assertion below is unchanged.
  let item: string;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    doc = await draftDocument(db, a);
    ({ itemId: item } = await seedItem(db, a, { code: "ITM-2A" }));
  });
  afterAll(async () => {
    await db.stop();
  });

  const insert = (lineNo: number, extra: Record<string, unknown> = {}) =>
    withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const id = await uuidv7(db.admin);
      await tx`insert into app.document_line ${tx({
        id,
        tenant_id: a.tenant,
        company_id: a.company,
        document_id: doc,
        line_no: lineNo,
        ...extra,
      })}`;
      return id;
    });

  it("an existing journal line keeps working and reads back as kind 'account' with zeroed money columns", async () => {
    const id = await insert(1, { account_id: a.cash, debit: "10.0000" });
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<Record<string, string | null>[]>`
        select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
               discount::text as discount, amount::text as amount, tax_code_id,
               tax_amount::text as tax_amount, total_incl_tax::text as total_incl_tax, cost::text as cost
          from app.document_line where id = ${id}`,
    );
    expect(row).toEqual({
      kind: "account",
      item_id: null,
      quantity: null,
      unit_price: null,
      discount: "0.0000",
      amount: "0.0000",
      tax_code_id: null,
      tax_amount: "0.0000",
      total_incl_tax: "0.0000",
      cost: null,
    });
  });

  it("an item line carries a quantity at scale 6 and money at scale 4", async () => {
    const id = await insert(2, {
      kind: "item",
      item_id: item,
      quantity: "3.500000",
      unit_price: "12.3456",
      discount: "1.0000",
      amount: "42.2096",
      tax_amount: "2.5326",
      total_incl_tax: "44.7422",
    });
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        {
          kind: string;
          item_id: string;
          quantity: string;
          unit_price: string;
          total_incl_tax: string;
        }[]
      >`
        select kind, item_id, quantity::text as quantity, unit_price::text as unit_price,
               total_incl_tax::text as total_incl_tax from app.document_line where id = ${id}`,
    );
    expect(row).toEqual({
      kind: "item",
      item_id: item,
      quantity: "3.500000",
      unit_price: "12.3456",
      total_incl_tax: "44.7422",
    });
  });

  it("kind admits the six registered kinds after 6A and refuses an unknown kind", async () => {
    for (const [index, kind] of ["account", "item", "tax", "text", "tender", "payroll"].entries()) {
      await expect(insert(1000 + index, { kind })).resolves.toBeDefined();
    }
    await expect(insert(400, { kind: "unknown" })).rejects.toThrow(/document_line_kind_check/);
  });

  it("the kind CHECK carries the exact name 6A's 0061 and 8B's 0087 both drop", async () => {
    const rows = await db.admin<{ conname: string }[]>`
      select conname from pg_constraint
       where conrelid = 'app.document_line'::regclass and conname = 'document_line_kind_check'`;
    expect(rows).toHaveLength(1);
  });

  it("item_id and tax_code_id carry their owning slices' foreign keys", async () => {
    // 2A wrote "item_id and tax_code_id carry NO foreign key yet" and asserted the empty set. 0032 closed
    // the first of the two slots, so the assertion becomes the one constraint it added — and the second
    // half of the original sentence is asserted separately, because 5A's 0055 has not landed.
    const rows = await db.admin<{ conname: string }[]>`
      select conname from pg_constraint
       where conrelid = 'app.document_line'::regclass and contype = 'f'
         and pg_get_constraintdef(oid) like '%item_id%'`;
    expect(rows.map((r) => r.conname)).toEqual(["document_line_item_fk"]);
    const taxCodeFks = await db.admin<{ conname: string }[]>`
      select conname from pg_constraint
       where conrelid = 'app.document_line'::regclass and contype = 'f'
         and pg_get_constraintdef(oid) like '%tax_code_id%'`;
    expect(taxCodeFks.map((r) => r.conname)).toEqual(["document_line_tax_code_fk"]);
    // Unchanged assertion, changed meaning: it now says "a REAL item id is accepted", where before 0032
    // it said "any uuid is accepted".
    await expect(insert(300, { kind: "item", item_id: item })).resolves.toBeDefined();
  });

  it("since 3A's 0032, an item_id with no app.item row is a 23503", async () => {
    await expect(
      insert(301, { kind: "item", item_id: await uuidv7(db.admin) }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("document_line has no branch_id and never gains one (contracts §4.5.6)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'document_line' and column_name like '%branch%'`;
    expect(cols).toEqual([]);
  });

  it("the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
