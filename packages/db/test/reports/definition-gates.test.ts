import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATASETS, DATASET_IDS, DATASET_READ_CODES } from "../../src/reports/datasets";
import {
  cloneReportDefinition,
  createReportDefinition,
  updateReportDefinition,
} from "../../src/reports/definition-store";
import { NEVER_EXPORTED } from "../../src/export/tables";
import { ReportError } from "../../src/reports/errors";
import { assertDefinitionFields } from "../../src/reports/statement";
import { grantCodes, seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import { CATALOGUE_7B, readDefinition } from "../../../../tests/invariants/support/reports";
import { CATALOGUE_7C, readDefinition7C } from "../../../../tests/invariants/support/reports-7c";

/**
 * Phase 7 review, finding 1 — a report definition could escalate data access. A run executes as the tenant's
 * SYSTEM principal, so a definition's `permission` is the only data gate, and a clone or an edit could set it
 * and `dataset.source` to anything in the catalogue: an `admin.company.manage` holder cloned
 * `accounting.audit_log`, gated it on a weaker code and added the `before`/`after` row images, and the clone —
 * the code's highest version — became everyone's default run. Three rules close it (ADR 0065's amendment):
 *  (a) every dataset declares the read codes that may gate it, and validation refuses any other;
 *  (b) a code's `dataset.source` never changes across its versions, and the writer must hold the new
 *      `permission` and every permission the code's existing versions carry;
 *  (c) no dataset exposes a column the export registry pins as never leaving the system.
 */
const AUDIT = {
  version: 1,
  code: "accounting.audit_log",
  nameEn: "Audit log",
  nameAr: "سجل التدقيق",
  module: "accounting",
  permission: "admin.audit_log.read",
  parameters: [],
  dataset: { source: "audit_log", filters: [] },
  columns: [
    { field: "seq", labelEn: "Seq", labelAr: "التسلسل", format: "text", align: "start" },
    { field: "table_name", labelEn: "Table", labelAr: "الجدول", format: "text", align: "start" },
  ],
  groups: [],
  totals: [],
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};
const REGISTER = {
  ...AUDIT,
  code: "accounting.document_register",
  nameEn: "Document register",
  nameAr: "سجل المستندات",
  permission: "accounting.report.read",
  dataset: { source: "document", filters: [] },
  columns: [
    { field: "number", labelEn: "Number", labelAr: "الرقم", format: "text", align: "start" },
  ],
};

describe("report definitions cannot widen data access — Phase 7 review, finding 1", () => {
  let db: Db;
  let s: Seed;
  let auditCore: string;
  let registerCore: string;
  /** Holds admin.company.manage AND admin.audit_log.read — the review's scenario. */
  let admin: string;
  /** Holds admin.company.manage and inventory.stock.read, but not accounting.report.read. */
  let stockAdmin: string;
  /** Holds admin.company.manage only. */
  let manager: string;

  const member = async (label: string, codes: string[]): Promise<string> => {
    const id = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`human:${label}:${id}`}, ${label})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    await grantCodes(db, s, { codes, principalId: id });
    return id;
  };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "def-gates");
    auditCore = await seedReportDefinition(db, s, { code: AUDIT.code, definition: AUDIT });
    registerCore = await seedReportDefinition(db, s, {
      code: REGISTER.code,
      definition: REGISTER,
    });
    admin = await member("audit-admin", ["admin.company.manage", "admin.audit_log.read"]);
    stockAdmin = await member("stock-admin", ["admin.company.manage", "inventory.stock.read"]);
    manager = await member("manager", ["admin.company.manage"]);
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  type Tx = Parameters<Parameters<typeof withTenant>[3]>[0];
  const as = <T>(actor: string, fn: (tx: Tx) => Promise<T>) =>
    withTenant(db.rw, s.tenant, actor, fn);

  it("(a) the review's scenario: a clone of accounting.audit_log may not move to a weaker gate", async () => {
    await expect(
      as(admin, (tx) =>
        cloneReportDefinition(tx, {
          companyId: s.company,
          sourceId: auditCore,
          overrides: { permission: "accounting.report.read" },
        }),
      ),
    ).rejects.toThrowError(/\/permission .*audit_log/);
  });

  it("(b) a clone or an edit keeps its code's dataset source", async () => {
    await expect(
      as(admin, (tx) =>
        cloneReportDefinition(tx, {
          companyId: s.company,
          sourceId: auditCore,
          overrides: {
            dataset: { source: "document_event", filters: [] },
            columns: [
              {
                field: "event_kind",
                labelEn: "Event",
                labelAr: "الحدث",
                format: "text",
                align: "start",
              },
            ],
          },
        }),
      ),
    ).rejects.toThrowError(/\/dataset\/source/);
    // A tenant version is edited in place — and still cannot leave its code's source.
    const clone = await as(admin, (tx) =>
      cloneReportDefinition(tx, { companyId: s.company, sourceId: auditCore }),
    );
    await expect(
      as(admin, (tx) =>
        updateReportDefinition(tx, {
          id: clone.id,
          definition: {
            ...AUDIT,
            dataset: { source: "document_event", filters: [] },
            columns: [
              {
                field: "event_kind",
                labelEn: "Event",
                labelAr: "الحدث",
                format: "text",
                align: "start",
              },
            ],
          },
        }),
      ),
    ).rejects.toThrowError(/\/dataset\/source/);
  });

  it("(b) the writer must hold the definition's own read code to create, clone or edit it", async () => {
    for (const write of [
      (tx: Tx) => cloneReportDefinition(tx, { companyId: s.company, sourceId: auditCore }),
      (tx: Tx) =>
        createReportDefinition(tx, { companyId: s.company, definition: { ...AUDIT, nameEn: "x" } }),
    ]) {
      const refused = await as(manager, write).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(ReportError);
      expect((refused as ReportError).code).toBe("ERR_RBAC_FORBIDDEN");
      expect((refused as ReportError).message).toContain("admin.audit_log.read");
    }
  });

  it("(b) a code's gate cannot be moved to a sibling code the writer holds but the code's versions do not", async () => {
    // `document` admits both accounting.report.read and inventory.stock.read (7B's count register), so (a)
    // alone would let a stock administrator re-gate the document register on their own code and read every
    // document's party and total. The writer must also hold every permission the code already carries.
    const refused = await as(stockAdmin, (tx) =>
      cloneReportDefinition(tx, {
        companyId: s.company,
        sourceId: registerCore,
        overrides: { permission: "inventory.stock.read" },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ReportError);
    expect((refused as ReportError).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((refused as ReportError).message).toContain("accounting.report.read");
  });

  it("(c) the audit_log dataset no longer serves the before/after row images", async () => {
    await expect(
      as(admin, (tx) =>
        cloneReportDefinition(tx, {
          companyId: s.company,
          sourceId: auditCore,
          overrides: {
            columns: [
              ...AUDIT.columns,
              {
                field: "before",
                labelEn: "Before",
                labelAr: "قبل",
                format: "text",
                align: "start",
              },
            ] as never,
          },
        }),
      ),
    ).rejects.toThrowError(/has no such field: before/);
  });

  it("(c) no dataset exposes a column the export registry pins as never leaving the system", () => {
    for (const id of DATASET_IDS) {
      const pinned = NEVER_EXPORTED[id] ?? [];
      const fields = DATASETS[id].columns.map((c) => c.field);
      if (pinned.includes("*")) expect(fields, id).toEqual([]);
      for (const column of pinned) expect(fields, `${id}.${column}`).not.toContain(column);
      // The secret names, wherever a dataset might join them in from another table.
      for (const secret of [
        "object_key",
        "pin_hash",
        "auth_subject",
        "device_public_key",
        "payload",
      ])
        expect(fields, `${id}.${secret}`).not.toContain(secret);
    }
  });

  it("(a) every dataset declares a closed, non-empty gate set of catalogued codes, and every shipped definition passes it", async () => {
    const catalogue = new Set(
      (await db.admin<{ code: string }[]>`select code from app.permission`).map((r) => r.code),
    );
    expect(Object.keys(DATASET_READ_CODES).toSorted()).toEqual([...DATASET_IDS].toSorted());
    for (const id of DATASET_IDS) {
      expect(DATASET_READ_CODES[id].length, id).toBeGreaterThan(0);
      for (const code of DATASET_READ_CODES[id]) expect(catalogue.has(code), code).toBe(true);
    }
    const shipped = [
      ...CATALOGUE_7B.map((c) => readDefinition(c)),
      ...CATALOGUE_7C.map((c) => readDefinition7C(c)),
    ];
    expect(shipped).toHaveLength(32);
    for (const d of shipped)
      expect(
        DATASET_READ_CODES[d.dataset.source as keyof typeof DATASET_READ_CODES],
        d.code,
      ).toContain(d.permission);
  });

  // ── Phase 7 second review, finding 5: a column may require a stronger code than its dataset's gate ─────
  const LINES = {
    ...REGISTER,
    code: "accounting.line_register",
    dataset: {
      source: "document_line",
      filters: [] as { field: string; op: string; param: string }[],
    },
    parameters: [] as unknown[],
    columns: [
      { field: "line_no", labelEn: "Line", labelAr: "السطر", format: "text", align: "start" },
    ],
    totals: [] as unknown[],
    sort: [] as unknown[],
  };
  const COST_COLUMN = {
    field: "cost",
    labelEn: "Cost",
    labelAr: "التكلفة",
    format: "money",
    align: "end",
  };

  it("(d) document_line.cost needs inventory.cost.read — refused under accounting.report.read wherever it is named (7 second review, finding 5)", () => {
    const variants = {
      columns: { ...LINES, columns: [...LINES.columns, COST_COLUMN] },
      totals: { ...LINES, totals: [{ field: "cost", fn: "sum" }] },
      sort: { ...LINES, sort: [{ field: "cost", dir: "desc" }] },
      groups: { ...LINES, groups: [{ field: "cost", subtotal: false }] },
      filters: {
        ...LINES,
        parameters: [{ name: "minCost", kind: "text", required: false }],
        dataset: {
          source: "document_line",
          filters: [{ field: "cost", op: "gte", param: "minCost" }],
        },
      },
    };
    for (const [where, definition] of Object.entries(variants)) {
      expect(() => assertDefinitionFields(definition as never), where).toThrowError(
        /column 'cost' of dataset 'document_line' needs 'inventory.cost.read'/,
      );
    }
    // The same register without the cost column is a valid definition.
    expect(() => assertDefinitionFields(LINES as never)).not.toThrow();
  });

  it("(d) the cost datasets' figures are declared too, and every shipped definition still passes", () => {
    const required = DATASET_IDS.flatMap((id) =>
      DATASETS[id].columns.filter((c) => c.requires !== undefined).map((c) => `${id}.${c.field}`),
    );
    expect(required.toSorted()).toEqual(
      [
        "cost_consumption.unit_cost",
        "cost_consumption.value",
        "cost_layer.unit_cost",
        "cost_layer.value",
        "document_line.cost",
        "stock_valuation.value",
      ].toSorted(),
    );
    for (const id of DATASET_IDS)
      for (const c of DATASETS[id].columns)
        if (c.requires !== undefined)
          expect(c.requires, `${id}.${c.field}`).toBe("inventory.cost.read");
    for (const d of [
      ...CATALOGUE_7B.map((c) => readDefinition(c)),
      ...CATALOGUE_7C.map((c) => readDefinition7C(c)),
    ])
      expect(() => assertDefinitionFields(d), d.code).not.toThrow();
  });
});
