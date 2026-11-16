import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  archiveSavedView,
  createSavedView,
  getSavedView,
  listSavedViews,
  updateSavedView,
} from "../../src/reports/saved-view-store";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const DEF = {
  version: 1,
  code: "accounting.trial_balance",
  nameEn: "Trial balance",
  nameAr: "ميزان المراجعة",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
  dataset: {
    source: "account_balance",
    filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }],
  },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
  ],
  groups: [],
  totals: [],
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("the saved_view store — 7A Task 13", () => {
  let db: Db;
  let s: Seed;
  let other: Seed;
  let definitionId: string;
  let colleague: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "view-store");
    other = await seedTenantV2(db, "view-store-other");
    definitionId = await seedReportDefinition(db, s, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
    colleague = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${colleague}, 'human', ${`sub:${colleague}`}, 'Colleague')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${colleague})`;
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  type Tx = Parameters<Parameters<typeof withTenant>[3]>[0];
  const as = <T>(actor: string, fn: (tx: Tx) => Promise<T>, seed: Seed = s) =>
    withTenant(db.rw, seed.tenant, actor, fn);

  it("stamps the owner from the session and refuses a parameter the definition does not declare", async () => {
    const view = await as(s.human, (tx) =>
      createSavedView(tx, {
        companyId: s.company,
        reportDefinitionId: definitionId,
        nameEn: "Q1",
        parameters: { fiscalPeriodId: s.period },
      }),
    );
    expect(view.ownerPrincipalId).toBe(s.human);
    expect(view.shared).toBe(false);
    expect(view.parameters).toEqual({ fiscalPeriodId: s.period });
    // The jsonb is an OBJECT in the row, not a double-encoded string (the `::text::jsonb` bind).
    const [stored] = await db.admin<{ kind: string }[]>`
      select jsonb_typeof(parameters) as kind from app.saved_view where id = ${view.id}`;
    expect(stored!.kind).toBe("object");

    await expect(
      as(s.human, (tx) =>
        createSavedView(tx, {
          companyId: s.company,
          reportDefinitionId: definitionId,
          nameEn: "Bad",
          parameters: { nope: "x" },
        }),
      ),
    ).rejects.toThrowError(/declares no such parameter: nope/);
  });

  it("refuses a definition of another company — the composite FK binds only the tenant", async () => {
    const [foreign] = await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'VIEW-OTHER', 'Other company', 'MYR')
        returning id`,
    );
    await expect(
      as(s.human, (tx) =>
        createSavedView(tx, {
          companyId: foreign!.id,
          reportDefinitionId: definitionId,
          nameEn: "Cross",
          parameters: {},
        }),
      ),
    ).rejects.toThrowError(/was not found in company/);
  });

  it("lists a principal's own views plus the company's shared ones, never a colleague's private view", async () => {
    await as(colleague, (tx) =>
      createSavedView(tx, {
        companyId: s.company,
        reportDefinitionId: definitionId,
        nameEn: "Theirs private",
        parameters: {},
      }),
    );
    await as(colleague, (tx) =>
      createSavedView(tx, {
        companyId: s.company,
        reportDefinitionId: definitionId,
        nameEn: "Theirs shared",
        parameters: {},
        shared: true,
      }),
    );
    const names = (
      await as(s.human, (tx) => listSavedViews(tx, { companyId: s.company, limit: 100 }))
    ).map((v) => v.nameEn);
    expect(names).toContain("Q1");
    expect(names).toContain("Theirs shared");
    expect(names).not.toContain("Theirs private");
  });

  it("only the owner may update or archive; a colleague gets ERR_RBAC_FORBIDDEN from the STORE", async () => {
    const view = await as(s.human, (tx) =>
      createSavedView(tx, {
        companyId: s.company,
        reportDefinitionId: definitionId,
        nameEn: "Mine",
        parameters: {},
        shared: true,
      }),
    );
    await expect(
      as(colleague, (tx) => updateSavedView(tx, { id: view.id, nameEn: "Hijacked" })),
    ).rejects.toMatchObject({ code: "ERR_RBAC_FORBIDDEN" });
    await expect(as(colleague, (tx) => archiveSavedView(tx, view.id))).rejects.toThrowError(
      /only its owner may change a saved view/,
    );
    const updated = await as(s.human, (tx) =>
      updateSavedView(tx, { id: view.id, shared: false, parameters: { fiscalPeriodId: s.period } }),
    );
    expect(updated.shared).toBe(false);
    expect(updated.nameEn).toBe("Mine");
    expect(updated.parameters).toEqual({ fiscalPeriodId: s.period });
    await expect(
      as(s.human, (tx) => updateSavedView(tx, { id: view.id, parameters: { nope: "x" } })),
    ).rejects.toThrowError(/declares no such parameter/);
  });

  it("archive sets archived_at and never issues a DELETE (spec:2049, hazard 25)", async () => {
    const view = await as(s.human, (tx) =>
      createSavedView(tx, {
        companyId: s.company,
        reportDefinitionId: definitionId,
        nameEn: "Gone",
        parameters: {},
      }),
    );
    await as(s.human, (tx) => archiveSavedView(tx, view.id));
    expect((await as(s.human, (tx) => getSavedView(tx, view.id)))!.archivedAt).not.toBeNull();
    // A second archive is a no-op, and an archived view cannot be edited.
    await as(s.human, (tx) => archiveSavedView(tx, view.id));
    await expect(
      as(s.human, (tx) => updateSavedView(tx, { id: view.id, nameEn: "Back" })),
    ).rejects.toThrowError(/is archived/);
    const live = await as(s.human, (tx) =>
      listSavedViews(tx, { companyId: s.company, limit: 100 }),
    );
    expect(live.map((v) => v.nameEn)).not.toContain("Gone");
  });

  it("pages newest first on (created_at, id) with no gaps", async () => {
    const all = await as(s.human, (tx) =>
      listSavedViews(tx, { companyId: s.company, limit: 1000 }),
    );
    const first = await as(s.human, (tx) => listSavedViews(tx, { companyId: s.company, limit: 2 }));
    const last = first.at(-1)!;
    const rest = await as(s.human, (tx) =>
      listSavedViews(tx, {
        companyId: s.company,
        limit: 1000,
        cursor: { createdAt: last.createdAt, id: last.id },
      }),
    );
    expect([...first, ...rest].map((v) => v.id)).toEqual(all.map((v) => v.id));
  });

  it("a second tenant sees none of these rows", async () => {
    const [any] = await as(s.human, (tx) => listSavedViews(tx, { companyId: s.company, limit: 1 }));
    expect(await as(other.human, (tx) => getSavedView(tx, any!.id), other)).toBeNull();
    expect(
      await as(
        other.human,
        (tx) => listSavedViews(tx, { companyId: s.company, limit: 100 }),
        other,
      ),
    ).toEqual([]);
  });
});
