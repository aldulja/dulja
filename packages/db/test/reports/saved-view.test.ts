import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

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
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("app.saved_view — contracts §4.11.2; archived, never deleted (spec:2049, hazard 25)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let definitionId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "saved-view-a");
    b = await seedTenantV2(db, "saved-view-b");
    definitionId = await seedReportDefinition(db, a, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  it("carries every column §4.11.2 names", async () => {
    const cols = await db.migrator<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'saved_view' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual([
      "archived_at",
      "company_id",
      "created_at",
      "id",
      "name_ar",
      "name_en",
      "owner_principal_id",
      "parameters",
      "report_definition_id",
      "shared",
      "tenant_id",
    ]);
  });

  it("defaults owner_principal_id to app.current_actor() and is NOT a *_by column (§3.3)", async () => {
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      async (tx) => tx<{ owner_principal_id: string; shared: boolean; parameters: unknown }[]>`
        insert into app.saved_view (tenant_id, company_id, report_definition_id, name_en)
        values (${a.tenant}, ${a.company}, ${definitionId}, 'My period')
        returning owner_principal_id, shared, parameters`,
    );
    expect(row).toEqual({ owner_principal_id: a.human, shared: false, parameters: {} });
    const triggers = await db.migrator<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.saved_view'::regclass and not tgisinternal order by tgname`;
    // owner_principal_id records WHOM the view belongs to, which is data — so it takes the column default and
    // gets no stamp trigger. A *_by spelling would either fail the stamp_actor linter rule or silently replace
    // the owner with whoever last touched the row, which is LEGACY-044 in the opposite direction (§3.3).
    expect(triggers.map((t) => t.tgname)).toEqual(["audit_row"]);
  });

  it("app_rw cannot DELETE — a view is archived (§3.5.4's pinned list is unchanged by 7A)", async () => {
    const id = await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.saved_view (tenant_id, company_id, report_definition_id, name_en)
        values (${a.tenant}, ${a.company}, ${definitionId}, 'Q1 by branch') returning id`;
      return row!.id;
    });
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.saved_view where id = ${id}`),
    ).rejects.toMatchObject({ code: "42501" });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.saved_view set archived_at = now() where id = ${id}`;
    });
    const [still] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.saved_view where id = ${id} and archived_at is not null`,
    );
    expect(still!.n).toBe(1);
    const audit = await db.admin<{ action: string }[]>`
      select action from app.audit_log where table_name = 'saved_view' and row_id = ${id} order by seq`;
    expect(audit.map((r) => r.action)).toEqual(["insert", "update"]);
  });

  it("a second tenant cannot see it, and cannot point a view at another tenant's definition", async () => {
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      async (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.saved_view`,
    );
    expect(seen[0]!.n).toBe(0);
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`insert into app.saved_view (tenant_id, company_id, report_definition_id, name_en)
                   values (${b.tenant}, ${b.company}, ${definitionId}, 'stolen')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("reports zero linter violations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "saved_view")).toEqual([]);
  });
});
