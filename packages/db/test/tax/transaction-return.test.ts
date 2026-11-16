import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema, listApplied } from "../../src";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { draftDocument, seedAccount, seedTaxCode, seedTenantV2, type Seed } from "../fixtures";

let db: Db;
let a: Seed;
let b: Seed;
let taxCodeId: string;
let regimeId: string;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "txn-a");
  await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
  b = await seedTenantV2(db, "txn-b");
  await grantCodes(db, b); // 6C: explicit company-wide branch visibility; no permission codes.
  await seedAccount(db, a, { code: "2300", nameEn: "Output tax payable", type: "liability" });
  ({ taxCodeId, regimeId } = await seedTaxCode(db, a));
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

/** The one insert path a DB-tier test may use: this file is inside `packages/db/test/**`, which is on the
 *  `posting-only-tables` allow-list (§3.7.5). Every OTHER file writes tax transactions through postDocument. */
async function insertTxn(s: Seed, docId: string, lineNo: number, tax: string) {
  return withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    insert into app.tax_transaction (tenant_id, company_id, document_id, line_no, tax_code_id, regime_id,
                                     base, tax, base_base, tax_base, effective_date, fiscal_period_id, posting_seq)
    values (${s.tenant}, ${s.company}, ${docId}, ${lineNo}, ${taxCodeId}, ${regimeId},
            100.0000, ${tax}, 100.0000, ${tax}, '2026-01-15', ${s.period}, 1)
    returning id`,
  );
}

describe("migration 0054 — tax_transaction, tax_return, document.tax_inclusive (§4.9.2, §4.3.4)", () => {
  it("applies as version 54 and lintSchema reports zero violations", async () => {
    expect(await listApplied(db.migrator)).toContain(54);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("tax_transaction is in AUDIT_EXEMPT and IMMUTABLE, and nothing else moved (§3.5.3)", () => {
    expect(AUDIT_EXEMPT.has("tax_transaction")).toBe(true);
    expect(IMMUTABLE.has("tax_transaction")).toBe(true);
    expect(AUDIT_EXEMPT.has("tax_return")).toBe(false);
    expect(IMMUTABLE.has("tax_return")).toBe(false);
    expect(AUDIT_EXEMPT.has("tax_code")).toBe(false);
    expect(AUDIT_EXEMPT.has("tax_regime")).toBe(false);
  });

  it("all four monetary columns are NOT NULL — a return can never carry tax without base (LEGACY-011)", async () => {
    const cols = await db.admin<
      { column_name: string; is_nullable: string; numeric_scale: number }[]
    >`
      select column_name, is_nullable, numeric_scale from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_transaction'
         and column_name in ('base', 'tax', 'base_base', 'tax_base') order by column_name`;
    expect(cols).toHaveLength(4);
    for (const c of cols) {
      expect(c.is_nullable).toBe("NO");
      expect(c.numeric_scale).toBe(4);
    }
    // …and none of them has a DEFAULT that could quietly stand in for a missing figure.
    const [d] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_transaction'
         and column_name in ('base','tax','base_base','tax_base') and column_default is not null`;
    expect(d!.n).toBe(0);
  });

  it("tax_transaction is append-only: UPDATE and DELETE raise ERR_TABLE_IMMUTABLE, and app_rw holds neither", async () => {
    const docId = await draftDocument(db, a);
    const [row] = await insertTxn(a, docId, 1, "11.0000");
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.tax_transaction set tax = 12.0000 where id = ${row!.id}`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`delete from app.tax_transaction where id = ${row!.id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE|permission denied/);
    await expect(
      withTenant(
        db.admin,
        a.tenant,
        a.human,
        (tx) => tx`update app.tax_transaction set tax = 12.0000 where id = ${row!.id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    await expect(
      withTenant(
        db.admin,
        a.tenant,
        a.human,
        (tx) => tx`delete from app.tax_transaction where id = ${row!.id}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'tax_transaction' order by 1`;
    expect(grants.map((g) => g.privilege_type).toSorted()).toEqual(["INSERT", "SELECT"]);
  });

  it("one code may appear once per document line — unique (document_id, line_no, tax_code_id)", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await insertTxn(a, docId, 1, "11.0000");
    await expect(insertTxn(a, docId, 1, "11.0000")).rejects.toThrow(
      /tax_transaction_document_id_line_no_tax_code_id_key/,
    );
    await expect(insertTxn(a, docId, 2, "11.0000")).resolves.toBeDefined(); // a second LINE is fine
  });

  it("tax_return.generated_by is nullable with NO default, so a draft carries none", async () => {
    const [c] = await db.admin<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'tax_return' and column_name = 'generated_by'`;
    expect(c).toMatchObject({ is_nullable: "YES", column_default: null });
    const [t] = await db.admin<{ tgname: string }[]>`
      select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = 'tax_return' and t.tgname = 'stamp_generated_by' and not t.tgisinternal`;
    expect(t).toBeDefined();
    // The key is the SINGLE-column form every earlier slice uses for app.principal, which is GLOBAL and
    // has no `unique (tenant_id, id)` for a composite key to target (plan0A:988-998, §3.5.3).
    const fks = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.tax_return'::regclass and contype = 'f'
         and pg_get_constraintdef(oid) like '%principal%'`;
    expect(fks.map((f) => f.def)).toEqual([
      "FOREIGN KEY (generated_by) REFERENCES app.principal(id)",
    ]);
  });

  it("generated_by is stamped on the NULL → value transition and immutable afterwards (plan0A:2365)", async () => {
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        insert into app.tax_return (tenant_id, company_id, regime_id, period_start, period_end, status)
        values (${a.tenant}, ${a.company}, ${regimeId}, '2026-01-01', '2026-03-31', 'draft') returning id`;
      return r!.id;
    });
    const [drafted] = await db.admin<{ generated_by: string | null }[]>`
      select generated_by from app.tax_return where id = ${id}`;
    expect(drafted!.generated_by).toBeNull();
    // The NULL → value transition: a supplied value is REPLACED with the session actor, never trusted (LEGACY-044).
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`
      update app.tax_return set status = 'generated', payload = '{}', payload_sha256 = sha256(''::bytea),
                                generated_by = ${b.human} where id = ${id}`,
    );
    const [gen] = await db.admin<
      { generated_by: string }[]
    >`select generated_by from app.tax_return where id = ${id}`;
    expect(gen!.generated_by).toBe(a.human);
    // A regeneration keeps the FIRST generator — 1A's closed_by decision (§4.3.4); app.audit_log is the
    // per-generation record with its own stamped actor.
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.system,
        (tx) => tx`update app.tax_return set generated_by = ${a.system} where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.system,
        (tx) => tx`update app.tax_return set payload = '{"v":2}' where id = ${id}`,
      ),
    ).resolves.toBeDefined();
  });

  it("the return's status vocabulary is text + CHECK and already admits 'filed' for 5B", async () => {
    const [c] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.tax_return'::regclass and conname = 'tax_return_status_check'`;
    for (const s of ["draft", "generated", "filed"]) expect(c!.def).toContain(`'${s}'`);
  });

  it("one return per company, regime and period start", async () => {
    const idx = await db.admin<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'app' and tablename = 'tax_return'`;
    expect(idx.map((i) => i.indexdef).join("\n")).toMatch(
      /UNIQUE INDEX .* ON app\.tax_return USING btree \(company_id, regime_id, period_start\)/,
    );
  });

  it("document.tax_inclusive exists, is NOT NULL and defaults false (§4.3.4's 5A row)", async () => {
    const [c] = await db.admin<{ is_nullable: string; column_default: string }[]>`
      select is_nullable, column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'document' and column_name = 'tax_inclusive'`;
    expect(c).toMatchObject({ is_nullable: "NO", column_default: "false" });
    const docId = await draftDocument(db, a);
    const [d] = await db.admin<{ tax_inclusive: boolean }[]>`
      select tax_inclusive from app.document where id = ${docId}`;
    expect(d!.tax_inclusive).toBe(false); // every document posted in Phases 1-4 reads false
  });

  it("tenant B sees neither table's rows (spec:106, test 12)", async () => {
    const docId = await draftDocument(db, a, { clientRef: await uuidv7(db.admin) });
    await insertTxn(a, docId, 9, "11.0000");
    const theirs = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ t: number; r: number }[]>`
      select (select count(*)::int from app.tax_transaction) as t,
             (select count(*)::int from app.tax_return) as r`,
    );
    expect(theirs[0]).toEqual({ t: 0, r: 0 });
  });
});
