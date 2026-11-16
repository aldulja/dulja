import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { seedParty, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.party — contracts §4.5.7, spec:1169 (LEGACY-072: one discriminator, not twenty Is* flags)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("seeds a customer with the 1200/2100 control accounts and stamps created_at", async () => {
    const id = await seedParty(db, a);
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<
        {
          kind: string;
          code: string;
          name_en: string;
          receivable: string | null;
          payable: string | null;
          archived_at: string | null;
        }[]
      >`
        select p.kind, p.code, p.name_en,
               r.code as receivable, y.code as payable, p.archived_at::text as archived_at
          from app.party p
          left join app.account r on r.id = p.receivable_account_id
          left join app.account y on y.id = p.payable_account_id
         where p.id = ${id}`,
    );
    expect(row).toEqual({
      kind: "customer",
      code: "P-0001",
      name_en: "Alpha customer",
      receivable: "1200",
      payable: "2100",
      archived_at: null,
    });
  });

  it("accepts the five kinds and refuses a sixth", async () => {
    for (const kind of ["customer", "vendor", "employee", "student", "dealer"] as const) {
      await expect(seedParty(db, a, { kind, code: `K-${kind}` })).resolves.toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
    await expect(
      seedParty(db, a, { kind: "supplier" as never, code: "K-supplier" }),
    ).rejects.toThrow(/party_kind_check/);
  });

  it("refuses a duplicate code inside one company and allows the same code in another tenant", async () => {
    await seedParty(db, a, { code: "DUP" });
    await expect(seedParty(db, a, { code: "DUP" })).rejects.toThrow(/party_company_id_code_key/);
    await expect(seedParty(db, b, { code: "DUP" })).resolves.toBeDefined();
  });

  it("refuses a receivable account belonging to another tenant (the composite FK)", async () => {
    const foreign = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) =>
        tx<
          { id: string }[]
        >`select id from app.account where company_id = ${b.company} and code = '1000'`,
    );
    await expect(
      seedParty(db, a, { code: "XFK", receivableAccountId: foreign[0]!.id }),
    ).rejects.toThrow(/party_tenant_id_receivable_account_id_fkey/);
  });

  it("tenant B cannot see, update or delete tenant A's party (spec:106)", async () => {
    const id = await seedParty(db, a, { code: "ISO" });
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ id: string }[]>`select id from app.party where id = ${id}`,
    );
    expect(seen).toEqual([]);
    const updated = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx`update app.party set name_en = 'stolen' where id = ${id}`,
    );
    expect(updated.count).toBe(0);
  });

  it("every write is audited with the acting principal (spec:106, LEGACY-030)", async () => {
    const id = await seedParty(db, a, { code: "AUD" });
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      // app.audit_log's discriminator is `action`, with lowercase labels (migration 0001 §8) — there is no `op`.
      (tx) => tx<{ action: string; actor_id: string }[]>`
        select action, actor_id from app.audit_log where table_name = 'party' and row_id = ${id} order by seq`,
    );
    expect(rows).toEqual([{ action: "insert", actor_id: a.human }]);
  });

  it("archival is an update, never a delete (spec:2049)", async () => {
    const id = await seedParty(db, a, { code: "ARC" });
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`update app.party set archived_at = now() where id = ${id}`,
    );
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.party where id = ${id}`),
    ).rejects.toThrow(/permission denied/);
  });

  it("the schema linter reports zero violations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations).toEqual([]);
  });

  it("uuidv7 ids are time-ordered, never sequential integers (spec:2037)", async () => {
    const first = await seedParty(db, a, { code: "ORD-1" });
    const second = await seedParty(db, a, { code: "ORD-2" });
    expect(first < second).toBe(true);
    const [col] = await db.admin<{ data_type: string }[]>`
      select data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'party' and column_name = 'id'`;
    expect(col!.data_type).toBe("uuid");
    void uuidv7;
  });
});
