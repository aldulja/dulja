import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statementDefinition } from "@dulja/domain";
import { DATASET_IDS } from "../../src/reports/datasets";
import {
  archiveReportDefinition,
  cloneReportDefinition,
  createReportDefinition,
  getReportDefinition,
  listReportDefinitions,
  nextDefinitionVersion,
  reportDefinitionSets,
  updateReportDefinition,
} from "../../src/reports/definition-store";
import { grantCodes, seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
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

describe("the report_definition store — 7A Task 13", () => {
  let db: Db;
  let s: Seed;
  let other: Seed;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "def-store");
    other = await seedTenantV2(db, "def-store-other");
    // A writer holds the definition's own read code (Phase 7 review, finding 1); `definition-gates.test.ts`
    // proves the refusal without it.
    await grantCodes(db, s, { codes: ["accounting.report.read"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  type Tx = Parameters<Parameters<typeof withTenant>[3]>[0];
  const as = <T>(fn: (tx: Tx) => Promise<T>, seed: Seed = s) =>
    withTenant(db.rw, seed.tenant, seed.human, fn);

  it("reportDefinitionSets reads the permission catalogue from the DATABASE, not from @dulja/contracts", async () => {
    const sets = await as((tx) => reportDefinitionSets(tx));
    expect(sets.permissions.has("accounting.report.read")).toBe(true);
    expect(sets.permissions.has("accounting.report.export")).toBe(true);
    expect(sets.datasets.has("account_balance")).toBe(true);
    // OD-09 is unbuilt, so `pdc` is absent and 7A's registry is twenty-five members (7C adds its own later).
    expect(sets.datasets.size).toBe(DATASET_IDS.length);
    expect(sets.datasets.has("pdc")).toBe(false);
  });

  it("creates a validated definition and refuses an invalid one with JSON-Pointer paths", async () => {
    const row = await as((tx) =>
      createReportDefinition(tx, { companyId: s.company, definition: DEF, isCore: true }),
    );
    expect(row.version).toBe(1);
    expect(row.isCore).toBe(true);
    expect(row.clonedFrom).toBeNull();
    expect(row.definition.code).toBe("accounting.trial_balance");

    await expect(
      as((tx) =>
        createReportDefinition(tx, {
          companyId: s.company,
          definition: {
            ...DEF,
            code: "accounting.ledger",
            dataset: { source: "invoices", filters: [] },
          },
        }),
      ),
    ).rejects.toThrowError(/\/dataset\/source/);
  });

  it("refuses a field the dataset does not serve — including in columns[], which nothing else checks", async () => {
    await expect(
      as((tx) =>
        createReportDefinition(tx, {
          companyId: s.company,
          definition: {
            ...DEF,
            code: "accounting.period_comparison",
            columns: [
              {
                field: "acount_code",
                labelEn: "Code",
                labelAr: "الرمز",
                format: "text",
                align: "start",
              },
            ],
          },
        }),
      ),
    ).rejects.toThrowError(/dataset 'account_balance' has no such field: acount_code/);
  });

  it("STORES a statement definition, whose rows carry five fields its dataset does not declare", async () => {
    const statement = statementDefinition("profit_and_loss", {
      code: "accounting.profit_and_loss",
      nameEn: "Profit and loss",
      nameAr: "الأرباح والخسائر",
      permission: "accounting.report.read",
    });
    const row = await as((tx) =>
      createReportDefinition(tx, { companyId: s.company, definition: statement, isCore: true }),
    );
    expect(row.definition.groups.map((g) => g.field)).toEqual(["section_label"]);

    const branch = statementDefinition(
      "profit_and_loss",
      {
        code: "accounting.branch_profit_and_loss",
        nameEn: "Branch P&L",
        nameAr: "أرباح الفرع",
        permission: "accounting.report.read",
      },
      { perBranch: true },
    );
    await expect(
      as((tx) =>
        createReportDefinition(tx, { companyId: s.company, definition: branch, isCore: true }),
      ),
    ).resolves.toMatchObject({ isCore: true });
  });

  it("a clone takes max(version) + 1, is is_core false, and records cloned_from", async () => {
    const core = await seedReportDefinition(db, s, {
      code: "accounting.ledger",
      definition: { ...DEF, code: "accounting.ledger" },
    });
    expect(
      await as((tx) =>
        nextDefinitionVersion(tx, { companyId: s.company, code: "accounting.ledger" }),
      ),
    ).toBe(2);
    const clone = await as((tx) =>
      cloneReportDefinition(tx, { companyId: s.company, sourceId: core }),
    );
    expect(clone.version).toBe(2);
    expect(clone.isCore).toBe(false);
    expect(clone.clonedFrom).toBe(core);
    // 7B seeds a re-expressed code at version 2 with an upsert; max(version) + 1 is what keeps a second
    // clone from colliding with the first (§4.16.1).
    const second = await as((tx) =>
      cloneReportDefinition(tx, { companyId: s.company, sourceId: core }),
    );
    expect(second.version).toBe(3);
  });

  it("an archived version still counts towards max(version) — a number is never reused", async () => {
    const first = await seedReportDefinition(db, s, {
      code: "accounting.cash_book",
      definition: { ...DEF, code: "accounting.cash_book" },
      isCore: false,
    });
    await as((tx) => archiveReportDefinition(tx, first));
    const next = await as((tx) =>
      createReportDefinition(tx, {
        companyId: s.company,
        definition: { ...DEF, code: "accounting.cash_book" },
      }),
    );
    expect(next.version).toBe(2);
  });

  it("a clone may override any part of the definition, and the result is re-validated", async () => {
    const core = await seedReportDefinition(db, s, {
      code: "accounting.general_ledger",
      definition: { ...DEF, code: "accounting.general_ledger" },
    });
    const clone = await as((tx) =>
      cloneReportDefinition(tx, {
        companyId: s.company,
        sourceId: core,
        overrides: {
          nameEn: "My GL",
          columns: [
            {
              field: "account_name_en",
              labelEn: "Name",
              labelAr: "الاسم",
              format: "text",
              align: "start",
            },
          ],
        },
      }),
    );
    expect(clone.definition.nameEn).toBe("My GL");
    expect(clone.definition.columns).toHaveLength(1);

    await expect(
      as((tx) =>
        cloneReportDefinition(tx, {
          companyId: s.company,
          sourceId: core,
          overrides: { code: "accounting.other_report" },
        }),
      ),
    ).rejects.toThrowError(/keeps its source's code/);
    // An override that breaks the schema is refused by the same validator a create goes through.
    await expect(
      as((tx) =>
        cloneReportDefinition(tx, {
          companyId: s.company,
          sourceId: core,
          overrides: { columns: [] as never },
        }),
      ),
    ).rejects.toThrowError(/\/columns/);
  });

  it("a clone is refused across a company and across a tenant (the source is not found)", async () => {
    const core = await seedReportDefinition(db, s, {
      code: "accounting.day_book",
      definition: { ...DEF, code: "accounting.day_book" },
    });
    await expect(
      as((tx) => cloneReportDefinition(tx, { companyId: other.company, sourceId: core }), other),
    ).rejects.toThrowError(/was not found/);
    // Same tenant, a company id that is not the source's.
    await expect(
      as((tx) => cloneReportDefinition(tx, { companyId: other.company, sourceId: core })),
    ).rejects.toThrowError(/was not found/);
  });

  it("edits a tenant version in place and refuses to mutate a CORE version", async () => {
    const core = await seedReportDefinition(db, s, {
      code: "accounting.journal_register",
      definition: { ...DEF, code: "accounting.journal_register" },
      isCore: true,
    });
    const coreBefore = await db.admin<{ row: string }[]>`
      select to_jsonb(d)::text as row from app.report_definition d where d.id = ${core}`;
    const clone = await as((tx) =>
      cloneReportDefinition(tx, { companyId: s.company, sourceId: core }),
    );
    const edited = await as((tx) =>
      updateReportDefinition(tx, {
        id: clone.id,
        definition: { ...clone.definition, nameEn: "Edited" },
      }),
    );
    expect(edited.definition.nameEn).toBe("Edited");
    expect(edited.version).toBe(clone.version);

    await expect(
      as((tx) =>
        updateReportDefinition(tx, {
          id: core,
          definition: { ...DEF, code: "accounting.journal_register", nameEn: "No" },
        }),
      ),
    ).rejects.toThrowError(/is a core definition; clone it/);
    await expect(
      as((tx) =>
        updateReportDefinition(tx, {
          id: clone.id,
          definition: { ...clone.definition, code: "accounting.other_register" },
        }),
      ),
    ).rejects.toThrowError(/cannot change a definition's code/);
    const coreAfter = await db.admin<{ row: string }[]>`
      select to_jsonb(d)::text as row from app.report_definition d where d.id = ${core}`;
    expect(coreAfter[0]!.row).toBe(coreBefore[0]!.row);
  });

  it("archives rather than deletes, refuses a second archive and an edit, and drops out of the list", async () => {
    const id = await seedReportDefinition(db, s, {
      code: "accounting.account_statement",
      definition: { ...DEF, code: "accounting.account_statement" },
      isCore: false,
    });
    await as((tx) => archiveReportDefinition(tx, id));
    expect((await as((tx) => getReportDefinition(tx, id)))!.archivedAt).not.toBeNull();
    await expect(as((tx) => archiveReportDefinition(tx, id))).rejects.toThrowError(
      /already archived/,
    );
    await expect(
      as((tx) =>
        updateReportDefinition(tx, {
          id,
          definition: { ...DEF, code: "accounting.account_statement" },
        }),
      ),
    ).rejects.toThrowError(/is archived/);
    const live = await as((tx) =>
      listReportDefinitions(tx, {
        companyId: s.company,
        code: "accounting.account_statement",
        limit: 100,
      }),
    );
    expect(live).toEqual([]);
    const all = await as((tx) =>
      listReportDefinitions(tx, {
        companyId: s.company,
        code: "accounting.account_statement",
        includeArchived: true,
        limit: 100,
      }),
    );
    expect(all).toHaveLength(1);
  });

  it("lists keyset-paged on (code, version)", async () => {
    const page1 = await as((tx) =>
      listReportDefinitions(tx, { companyId: s.company, code: "accounting.ledger", limit: 2 }),
    );
    expect(page1.map((r) => r.version)).toEqual([1, 2]);
    const page2 = await as((tx) =>
      listReportDefinitions(tx, {
        companyId: s.company,
        code: "accounting.ledger",
        limit: 2,
        cursor: { code: page1[1]!.code, version: page1[1]!.version },
      }),
    );
    expect(page2.map((r) => r.version)).toEqual([3]);
  });

  it("a second tenant sees none of these rows", async () => {
    expect(
      await as((tx) => listReportDefinitions(tx, { companyId: s.company, limit: 1000 }), other),
    ).toEqual([]);
    const [any] = await as((tx) => listReportDefinitions(tx, { companyId: s.company, limit: 1 }));
    expect(await as((tx) => getReportDefinition(tx, any!.id), other)).toBeNull();
  });
});
