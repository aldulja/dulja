import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const DEF = {
  version: 1,
  code: "accounting.trial_balance",
  nameEn: "Trial balance",
  nameAr: "ميزان المراجعة",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [],
  dataset: { source: "account_balance", filters: [] },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
  ],
  groups: [],
  totals: [],
  sort: [{ field: "account_code", dir: "asc" }],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("app.report_definition — contracts §4.11.2, spec:1240 (text-defined, diffable, version-controlled)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "report-def-a");
    b = await seedTenantV2(db, "report-def-b");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("carries every column §4.11.2 names, at the declared types", async () => {
    const cols = await db.migrator<
      { column_name: string; data_type: string; is_nullable: string }[]
    >`
      select column_name, data_type, is_nullable
        from information_schema.columns
       where table_schema = 'app' and table_name = 'report_definition'
       order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "archived_at",
      "cloned_from",
      "code",
      "company_id",
      "created_at",
      "definition",
      "id",
      "is_core",
      "tenant_id",
      "version",
    ]);
    const byName = new Map(cols.map((c) => [c.column_name, c]));
    expect(byName.get("definition")!.data_type).toBe("jsonb");
    expect(byName.get("definition")!.is_nullable).toBe("NO");
    expect(byName.get("version")!.data_type).toBe("integer");
    expect(byName.get("is_core")!.is_nullable).toBe("NO");
    expect(byName.get("archived_at")!.is_nullable).toBe("YES");
  });

  it("is unique on (company_id, code, version) and refuses version 0", async () => {
    // postgres.js rethrows a statement's error from `begin` once the transaction is aborted, so each refusal is
    // its own transaction and the assertion is on that transaction's promise.
    const insert = (version: number) =>
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (
          tx,
        ) => tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
                   values (${a.tenant}, ${a.company}, 'accounting.ledger', ${version}, ${JSON.stringify(DEF)}::jsonb)`,
      );
    await insert(1);
    await expect(insert(1)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(0)).rejects.toMatchObject({ code: "23514" });
  });

  it("writes an audit row on insert and on update (spec:106; no AUDIT_EXEMPT membership — §3.5.3)", async () => {
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.report_definition (tenant_id, company_id, code, version, definition)
        values (${a.tenant}, ${a.company}, 'inventory.stock_on_hand', 1, ${JSON.stringify(DEF)}::jsonb)
        returning id`;
      await tx`update app.report_definition set archived_at = now() where id = ${row!.id}`;
      return row!.id;
    });
    // app.audit_log is itself forced-RLS, so a context-free read goes through the superuser connection.
    const rows = await db.admin<{ action: string }[]>`
      select action from app.audit_log
       where table_name = 'report_definition' and row_id = ${id} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert", "update"]);
  });

  it("a second tenant cannot see it (spec:106)", async () => {
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
               values (${a.tenant}, ${a.company}, 'accounting.general_ledger', 1, ${JSON.stringify(DEF)}::jsonb)`;
    });
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      async (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.report_definition`,
    );
    expect(seen[0]!.n).toBe(0);
  });

  it("refuses a cross-tenant company_id and an unknown cloned_from through the composite FKs", async () => {
    const bogus = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (
          tx,
        ) => tx`insert into app.report_definition (tenant_id, company_id, code, version, definition)
                   values (${a.tenant}, ${b.company}, 'accounting.journal_register', 1, ${JSON.stringify(DEF)}::jsonb)`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (
          tx,
        ) => tx`insert into app.report_definition (tenant_id, company_id, code, version, definition, cloned_from)
                   values (${a.tenant}, ${a.company}, 'accounting.account_statement', 1, ${JSON.stringify(DEF)}::jsonb, ${bogus})`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("seedReportDefinition writes a core row at definitionVersion, and a clone points at it (§4.17)", async () => {
    const core = await seedReportDefinition(db, a, {
      code: "accounting.ar_ageing",
      definition: DEF,
    });
    const clone = await seedReportDefinition(db, a, {
      code: "accounting.ar_ageing",
      definition: DEF,
      definitionVersion: 2,
      isCore: false,
      clonedFrom: core,
    });
    const rows = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      async (tx) => tx<
        { id: string; version: number; is_core: boolean; cloned_from: string | null }[]
      >`
        select id, version, is_core, cloned_from from app.report_definition
         where code = 'accounting.ar_ageing' order by version`,
    );
    expect(rows).toEqual([
      { id: core, version: 1, is_core: true, cloned_from: null },
      { id: clone, version: 2, is_core: false, cloned_from: core },
    ]);
  });

  it("reports zero linter violations (§3.5.2)", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "report_definition")).toEqual([]);
  });
});
