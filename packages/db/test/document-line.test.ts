import { grantCodes } from "./fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { draftDocument, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.document_line — contracts §4.3.4 (spec:1748, SAH-021, 035)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    b = await seedTenant(db, "Beta");
    await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  });
  afterAll(async () => {
    await db.stop();
  });

  it("accepts a two-line journal and defaults both bags to {}", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, debit)
               values (${a.tenant}, ${a.company}, ${doc}, 1, 'Cash received', ${a.cash}, 100.0000)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, description, account_id, credit)
               values (${a.tenant}, ${a.company}, ${doc}, 2, 'Sales', ${a.sales}, 100.0000)`;
    });
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          {
            line_no: number;
            debit: string;
            credit: string;
            dimensions: unknown;
            custom_fields: unknown;
          }[]
        >`select line_no, debit, credit, dimensions, custom_fields from app.document_line where document_id = ${doc} order by line_no`,
    );
    expect(rows.map((r) => r.line_no)).toEqual([1, 2]);
    expect(rows[0]!.debit).toBe("100.0000");
    expect(rows[1]!.credit).toBe("100.0000");
    expect(rows[0]!.dimensions).toEqual({});
    expect(rows[0]!.custom_fields).toEqual({});
  });

  it("refuses a line that is both a debit and a credit, a negative amount and line_no 0", async () => {
    const doc = await draftDocument(db, a);
    const insert = (lineNo: number, debit: string, credit: string) =>
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
        values (${a.tenant}, ${a.company}, ${doc}, ${lineNo}, ${a.cash}, ${debit}, ${credit})`,
      );
    await expect(insert(1, "5.0000", "5.0000")).rejects.toThrow(/document_line_check/);
    await expect(insert(2, "-5.0000", "0.0000")).rejects.toThrow(/document_line_debit_check/);
    await expect(insert(0, "5.0000", "0.0000")).rejects.toThrow(/document_line_line_no_check/);
  });

  it("refuses a duplicate line_no on one document", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
      values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 1.0000)`,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, credit)
        values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.sales}, 1.0000)`,
      ),
    ).rejects.toThrow(/document_line_document_id_line_no_key/);
  });

  it("cannot borrow another tenant's account through the composite FK (SAH-035)", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
        insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
        values (${a.tenant}, ${a.company}, ${doc}, 9, ${b.cash}, 1.0000)`,
      ),
    ).rejects.toThrow(/document_line_tenant_id_account_id_fkey/);
  });

  it("a second tenant sees no lines at all (spec:106 'a test that a second tenant cannot see it')", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
      values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 7.0000)`,
    );
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_line`,
    );
    expect(seen[0]!.n).toBe(0);
    const written = await withTenant(db.rw, b.tenant, b.human, async (tx) => {
      const r =
        await tx`update app.document_line set description = 'stolen' where document_id = ${doc}`;
      return r.count;
    });
    expect(written).toBe(0);
  });

  it("deleting a draft document cascades its lines", async () => {
    const doc = await draftDocument(db, a);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit)
      values (${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 3.0000)`,
    );
    // app_rw holds no DELETE on document until 2B's migration 0023, so the cascade is exercised as the owner.
    await withTenant(
      db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`delete from app.document where id = ${doc}`,
    );
    const rows = await withTenant(
      db.migrator,
      a.tenant,
      a.system,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.document_line where document_id = ${doc}`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("writes an audit row for the insert and the update (spec:106)", async () => {
    const doc = await draftDocument(db, a);
    const lineId = await uuidv7(db.admin);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.document_line (id, tenant_id, company_id, document_id, line_no, account_id, debit)
               values (${lineId}, ${a.tenant}, ${a.company}, ${doc}, 1, ${a.cash}, 2.0000)`;
      await tx`update app.document_line set description = 'corrected' where id = ${lineId}`;
    });
    const audit = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ action: string }[]>`
      select action from app.audit_log where table_name = 'document_line' and row_id = ${lineId} order by seq`,
    );
    expect(audit.map((r) => r.action)).toEqual(["insert", "update"]);
  });

  it("leaves the schema linter with zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
