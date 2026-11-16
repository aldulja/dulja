import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, listApplied } from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  draftDocument,
  draftTypedDocument,
  seedAccount,
  seedTaxCode,
  seedTenantV2,
  type Seed,
} from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "linefk-a");
  await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
  b = await seedTenantV2(db, "linefk-b");
  await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  await seedAccount(db, b, { code: "2300", nameEn: "Output tax payable", type: "liability" });
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

async function insertLine(s: Seed, docId: string, taxCodeId: string | null) {
  return withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id,
                                   amount, tax_code_id)
    values (${s.tenant}, ${s.company}, ${docId}, 1, 'account', ${s.cash}, 100.0000, ${taxCodeId})`,
  );
}

describe("migration 0055 — document_line.tax_code_id foreign key (§4.3.4)", () => {
  it("applies as version 55 and lintSchema reports zero violations", async () => {
    expect(await listApplied(db.migrator)).toContain(55);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the key is COMPOSITE (tenant_id, tax_code_id), not a plain reference (§3.5.1)", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.document_line'::regclass and conname = 'document_line_tax_code_fk'`;
    expect(c!.def).toBe(
      "FOREIGN KEY (tenant_id, tax_code_id) REFERENCES app.tax_code(tenant_id, id)",
    );
  });

  it("a null tax_code_id is still legal — every document posted in Phases 1-4 carries one (§4.9.2)", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(insertLine(a, docId, null)).resolves.toBeDefined();
  });

  it("an arbitrary uuid is now refused — what 2A's tests could legally write until this file landed", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(insertLine(a, docId, await uuidv7(db.admin))).rejects.toThrow(
      /document_line_tax_code_fk/,
    );
  });

  it("tenant B's tax code cannot be attached to tenant A's line — the composite half of the key", async () => {
    const foreign = await seedTaxCode(db, b, { code: "SYN-OUT-STD" });
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await expect(insertLine(a, docId, foreign.taxCodeId)).rejects.toThrow(
      /document_line_tax_code_fk/,
    );
    const mine = await seedTaxCode(db, a, { code: "SYN-OUT-STD" });
    await expect(insertLine(a, docId, mine.taxCodeId)).resolves.toBeDefined();
  });

  it("draftTypedDocument WRITES tax_code_id — amendment A12, the test-tier twin of the wire field", async () => {
    // Every taxed line in Tasks 7-9 reaches the database through this helper, directly or through 4B's
    // postFromPack (whose `lines` is `readonly DraftLine[]`). Before A12, `DraftLine` had no `taxCodeId`
    // and the helper's insert omitted the column, so a passed code was an excess property at compile time
    // and a dropped value at run time: no line would carry a code, computeDocumentTax would write zeros,
    // plan.taxLines would be empty and every box in T7/T8/T9 would read 0.0000 with nothing to say why.
    const mine = await seedTaxCode(db, a, { code: "A12-CHECK" });
    const { documentId, lineIds } = await draftTypedDocument(db, a, {
      documentTypeId: a.docType,
      series: "JV",
      effectiveDate: "2026-01-15",
      lines: [
        {
          kind: "account",
          lineNo: 1,
          accountId: a.cash,
          amount: "100.0000",
          taxCodeId: mine.taxCodeId,
        },
        { kind: "account", lineNo: 2, accountId: a.sales, amount: "100.0000" },
      ],
    });
    expect(lineIds).toHaveLength(2);
    const rows = await db.admin<{ line_no: number; tax_code_id: string | null }[]>`
      select line_no, tax_code_id from app.document_line where document_id = ${documentId} order by line_no`;
    expect(rows).toEqual([
      { line_no: 1, tax_code_id: mine.taxCodeId },
      { line_no: 2, tax_code_id: null },
    ]);
  });
});
