import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_IMAGE_RULES, EXPORT_TABLES, NEVER_EXPORTED } from "@dulja/db";
import { ROLES } from "@dulja/db/seed/roles";
import {
  draftDocument,
  grantCodes,
  JOURNAL_POLICY_V1,
  seedDocumentType,
  seedTenant,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

/**
 * ADR 0090 — what an audit reader may see (review findings DBS-01 = API-02 = HRP-01, 2026-11-15). The audit log
 * copies every audited row whole, so `GET /v1/admin/audit-log` served compensation lines, statutory profiles and
 * payroll rows to the seeded auditor (who holds no `hr.compensation.read`, spec:2163), and every company's trail
 * to a reader assigned in one. Every case here failed on the route before ADR 0090.
 */
interface Entry {
  seq: string;
  tableName: string;
  rowId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  imagesWithheld: boolean;
}

const AUDITOR = ROLES.find((role) => role.code === "auditor")!.permissions;

describe("/v1/admin/audit-log — row and image gates (ADR 0090)", () => {
  let api: StartedApi;
  let s: Seed;
  let companyB: string;
  /** the seeded auditor's codes in company A only */
  let auditorA: string;
  /** the seeded auditor's codes in A and B */
  let auditorAB: string;
  /** the auditor's codes in A and B, plus hr.compensation.read in A */
  let hrAuditor: string;
  /** admin.audit_log.read alone, in A and B — no module code */
  let bare: string;
  let hrDocument: string;
  let journalDocument: string;
  const planted = new Map<string, string>(); // table name → row_id of its company-A image

  const read = async (as: string, query: string): Promise<Entry[]> => {
    const response = await api.request({
      method: "GET",
      path: `/v1/admin/audit-log?limit=1000&${query}`,
      as,
    });
    expect(response.status, query).toBe(200);
    return ((await response.json()) as { items: Entry[] }).items;
  };

  const principal = async (name: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${id}, 'human', ${`human:${id}`}, ${name})`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
    });
    return id;
  };

  const plant = async (tableName: string, after: Record<string, unknown>): Promise<string> => {
    const rowId = await uuidv7(api.db.admin);
    await api.db.admin`
      insert into app.audit_log (tenant_id, actor_id, table_name, row_id, action, after)
      values (${s.tenant}, ${s.system}, ${tableName}, ${rowId}, 'insert', ${JSON.stringify(after)}::text::jsonb)`;
    return rowId;
  };

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenant(api.db, "AuditGates");
    companyB = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`insert into app.company (id, tenant_id, code, name, base_currency)
                 values (${companyB}, ${s.tenant}, 'B2', 'Second company', 'MYR')`,
    );
    const inB = { ...s, company: companyB };
    auditorA = await principal("Auditor A");
    await grantCodes(api.db, s, { codes: AUDITOR, principalId: auditorA });
    auditorAB = await principal("Auditor AB");
    await grantCodes(api.db, s, { codes: AUDITOR, principalId: auditorAB });
    await grantCodes(api.db, inB, { codes: AUDITOR, principalId: auditorAB });
    hrAuditor = await principal("HR auditor");
    await grantCodes(api.db, s, {
      codes: [...AUDITOR, "hr.compensation.read"],
      principalId: hrAuditor,
    });
    await grantCodes(api.db, inB, { codes: AUDITOR, principalId: hrAuditor });
    bare = await principal("Bare reader");
    await grantCodes(api.db, s, { codes: ["admin.audit_log.read"], principalId: bare });
    await grantCodes(api.db, inB, { codes: ["admin.audit_log.read"], principalId: bare });

    // One image per registered table, in company A: every column the registry names plus a column it does
    // not, so a projection that lets an unregistered key through is caught.
    for (const table of EXPORT_TABLES) {
      const image: Record<string, unknown> = { company_id: s.company, not_registered: "leak" };
      for (const column of table.columns) if (column !== "company_id") image[column] = "v";
      planted.set(table.name, await plant(table.name, image));
    }
    // a compensation line of company B — the reviewer's cross-company scenario.
    planted.set(
      "compensation_line@B",
      await plant("compensation_line", { company_id: companyB, amount: "12345.0000" }),
    );
    // a table whose images never leave (pinned whole).
    planted.set(
      "terminal_enrolment",
      await plant("terminal_enrolment", { company_id: s.company, code_hash: "secret" }),
    );

    // A real `hr` document and a real JOURNAL in company A: each insert writes a `document` audit row.
    const hrType = await seedDocumentType(api.db, s, {
      code: "HRDOC",
      module: "hr",
      policy: { ...JOURNAL_POLICY_V1, documentType: "HRDOC" },
    });
    const [policy] = await api.db.admin<{ id: string }[]>`
      select id from app.posting_policy where document_type_id = ${hrType}`;
    hrDocument = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`
        insert into app.document (id, tenant_id, company_id, document_type_id, posting_policy_id, series,
                                  fiscal_period_id, effective_date, currency, branch_id)
        values (${hrDocument}, ${s.tenant}, ${s.company}, ${hrType}, ${policy!.id}, 'HR', ${s.period},
                '2026-01-15', 'MYR', ${s.hq})`,
    );
    // `seedTenant` assigns s.human nothing, and branch_isolation admits a draft only to a principal in the company.
    await grantCodes(api.db, s, { codes: ["accounting.journal.create"] });
    journalDocument = await draftDocument(api.db, s);
    planted.set(
      "document_line@hr",
      await plant("document_line", { document_id: hrDocument, line_no: 1, amount: "2000.0000" }),
    );
    await api.loadPrincipals();
  }, 240_000);
  afterAll(async () => api.stop());

  it("withholds compensation images from the seeded auditor (DBS-01/API-02/HRP-01)", async () => {
    const rows = await read(auditorA, "tableName=compensation_line");
    const mine = rows.find((row) => row.rowId === planted.get("compensation_line"));
    expect(mine, "the row itself stays in the trail").toBeDefined();
    expect(mine!.before).toBeNull();
    expect(mine!.after).toBeNull();
    expect(mine!.imagesWithheld).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("12345.0000");
  });

  it("serves every registered table's image exactly when the reader holds its gate in the row's company", async () => {
    const rows = await read(auditorA, "");
    const byRow = new Map(rows.map((row) => [row.rowId, row]));
    for (const table of EXPORT_TABLES) {
      const row = byRow.get(planted.get(table.name)!);
      expect(row, table.name).toBeDefined();
      const rule = AUDIT_IMAGE_RULES.get(table.name);
      const visible = rule !== undefined && (rule.gate === null || AUDITOR.includes(rule.gate));
      expect(row!.imagesWithheld, `${table.name} gated by ${table.gate}`).toBe(!visible);
      if (!visible) {
        expect(row!.after, table.name).toBeNull();
        continue;
      }
      const pinned = new Set(NEVER_EXPORTED[table.name] ?? []);
      for (const key of Object.keys(row!.after!)) {
        expect(table.columns.includes(key) && !pinned.has(key), `${table.name}.${key}`).toBe(true);
      }
      expect(row!.after).not.toHaveProperty("not_registered");
    }
  });

  it("serves a compensation image to a reader holding hr.compensation.read in that company only", async () => {
    const rows = await read(hrAuditor, "tableName=compensation_line");
    const a = rows.find((row) => row.rowId === planted.get("compensation_line"));
    const b = rows.find((row) => row.rowId === planted.get("compensation_line@B"));
    expect(a!.imagesWithheld).toBe(false);
    expect(a!.after).toHaveProperty("amount", "v");
    expect(b!.imagesWithheld, "no hr.compensation.read in company B").toBe(true);
    expect(b!.after).toBeNull();
  });

  it("shows a reader only the companies they hold the audit read in", async () => {
    const onlyA = await read(auditorA, "tableName=compensation_line");
    expect(onlyA.map((row) => row.rowId)).not.toContain(planted.get("compensation_line@B"));
    const companyRows = await read(auditorA, "tableName=company");
    expect(companyRows.map((row) => row.rowId)).toContain(s.company);
    expect(companyRows.map((row) => row.rowId)).not.toContain(companyB);

    const both = await read(auditorAB, "tableName=compensation_line");
    expect(both.map((row) => row.rowId)).toContain(planted.get("compensation_line@B"));
  });

  it("shows rows with no company only to a reader holding the audit read in every company", async () => {
    // (the planted `tenant`/`principal` images name company A; the real rows name no company)
    const tenantA = await read(auditorA, "tableName=tenant");
    expect(tenantA.map((row) => row.rowId)).toEqual([planted.get("tenant")]);
    const principalA = await read(auditorA, "tableName=principal");
    expect(principalA.map((row) => row.rowId)).toEqual([planted.get("principal")]);
    const tenantRows = await read(auditorAB, "tableName=tenant");
    expect(tenantRows.map((row) => row.rowId)).toContain(s.tenant);
    const principals = await read(auditorAB, "tableName=principal");
    expect(principals.map((row) => row.rowId)).toContain(auditorA);
    // `principal.auth_subject` is pinned in NEVER_EXPORTED: it does not leave through the trail either.
    for (const row of principals) expect(row.after).not.toHaveProperty("auth_subject");
  });

  it("never serves the images of a table pinned whole", async () => {
    const rows = await read(auditorAB, "tableName=terminal_enrolment");
    const row = rows.find((entry) => entry.rowId === planted.get("terminal_enrolment"));
    expect(row!.imagesWithheld).toBe(true);
    expect(row!.after).toBeNull();
  });

  it("withholds an hr document's images without hr.payroll.read (MODULE_ROW_GATES)", async () => {
    const documents = await read(bare, "tableName=document");
    const hr = documents.find((row) => row.rowId === hrDocument);
    const journal = documents.find((row) => row.rowId === journalDocument);
    expect(hr!.imagesWithheld).toBe(true);
    expect(hr!.after).toBeNull();
    expect(journal!.imagesWithheld).toBe(false);
    expect(journal!.after).toHaveProperty("id", journalDocument);

    const lines = await read(bare, "tableName=document_line");
    const hrLine = lines.find((row) => row.rowId === planted.get("document_line@hr"));
    expect(hrLine!.imagesWithheld).toBe(true);

    // the seeded auditor holds hr.payroll.read (spec:2163, the payroll register), so it sees both.
    const audited = await read(auditorA, "tableName=document_line");
    const seen = audited.find((row) => row.rowId === planted.get("document_line@hr"));
    expect(seen!.imagesWithheld).toBe(false);
    expect(seen!.after).toHaveProperty("document_id", hrDocument);
  });
});
