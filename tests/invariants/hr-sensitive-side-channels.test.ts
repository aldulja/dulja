import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENSITIVE_WIRE_FIELDS } from "@dulja/contracts/hr/sensitive";
import {
  EVERY_ROW,
  EXPORT_TABLES,
  exportTable,
  getExportJob,
  MemoryObjectStore,
  NEVER_EXPORTED,
  objectKeyFor,
  resolveExportGates,
  runExport,
  SENSITIVE_FIELDS,
  withTenant,
  type TenantContext,
} from "@dulja/db";
import { seedExportJob, seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { repoFile } from "../support/regression";
import { startApi } from "../../apps/api/test/support/app"; // as tenant-isolation.test.ts does
import { hrFixture, type HrFixture } from "./support/hr";
import { moneyOutFixture, postPayrollPayment, type MoneyOutFixture } from "./support/payroll-money";
import { postJournal } from "./support/post-journal";

/** Acceptance test 32 (spec:2450). Five channels: endpoint, filter, sort, search, export — plus the OpenAPI
 *  document and a direct app_rw query, both named in the test's own sentence. The endpoint, filter and sort
 *  channels are asserted in apps/api/test/routes/hr/sensitive.test.ts; this file holds the two the route suite
 *  structurally cannot see. The export channel is 8A Task 14's (amendment A20). */
describe("test 32 — sensitive fields have no side channel", () => {
  let f: HrFixture;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-side-channels");
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  /**
   * The schemas each wire name is allowed to appear in. Eight of the nine live in the sensitive pair and nowhere
   * else. **`residencyCategory` is the documented exception:** migration 0082 keeps a PLAINTEXT copy on
   * `app.employee_statutory_profile` because it is a payroll calculation input rather than an identifier, so it is
   * also a property of `StatutoryProfile` and `OpenStatutoryProfileBody` — both gated by the compensation read /
   * manage codes and by the `compensation_gate` RLS policy, the same strength of control as `sensitive_gate`. Test
   * 32 asks that no field reach a principal WITHOUT the right code, not that a field appear exactly once; the
   * assertion is therefore a subset check against a named allow-list, and a tenth carrier of any name still fails.
   */
  const SENSITIVE_PAIR = ["EmployeeSensitive", "UpdateEmployeeSensitiveBody"];
  // **`workPermitExpiry` has one more carrier, `PermitExpiry`** (8D T3, amendment A3): the permit half of spec:2091's
  // expiry list, served by `GET …/employees/permit-expiry` under `hr.employee.read_sensitive` — the sensitive pair's own
  // code — and decrypted behind the same RESTRICTIVE `sensitive_gate`. Same code, same strength of control.
  const ALLOWED_CARRIERS: Record<string, string[]> = Object.fromEntries(
    SENSITIVE_WIRE_FIELDS.map((field) => [
      field,
      field === "residencyCategory"
        ? [...SENSITIVE_PAIR, "StatutoryProfile", "OpenStatutoryProfileBody"]
        : field === "workPermitExpiry"
          ? [...SENSITIVE_PAIR, "PermitExpiry"]
          : SENSITIVE_PAIR,
    ]),
  );

  it("the committed OpenAPI document declares each of the nine names only in its allowed schemas", () => {
    const doc = JSON.parse(repoFile("packages/contracts/openapi.json")) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    for (const field of SENSITIVE_WIRE_FIELDS) {
      const carriers = Object.entries(doc.components.schemas)
        .filter(([, s]) => s.properties !== undefined && field in s.properties)
        .map(([name]) => name)
        .toSorted();
      for (const carrier of carriers) {
        expect(ALLOWED_CARRIERS[field], `${field} leaked into ${carrier}`).toContain(carrier);
      }
      // and the pair is always present, so a field cannot disappear from the API and pass silently
      expect(carriers).toEqual(expect.arrayContaining(SENSITIVE_PAIR));
    }
  });

  it("no query parameter anywhere in the document names a sensitive field", () => {
    const doc = JSON.parse(repoFile("packages/contracts/openapi.json")) as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
    };
    const names = Object.values(doc.paths)
      .flatMap((ops) => Object.values(ops))
      .flatMap((op) => op.parameters ?? [])
      .map((p) => p.name);
    for (const field of SENSITIVE_WIRE_FIELDS) {
      expect(names.filter((n) => n.includes(field))).toEqual([]);
    }
  });

  it("a direct app_rw query under the PRODUCTION withTenant returns zero rows without the code", async () => {
    // Seed a row first so the zero is the gate's and not an empty table's.
    const put = await f.api.request({
      method: "PUT",
      path: `/v1/companies/${f.companyId}/employees/${f.employees[1]!.id}/sensitive`,
      as: f.officer,
      body: { taxNumber: "SYNTHETIC-TAX-3" },
    });
    expect(put.status).toBe(200);
    const ctx = {
      tenantId: f.seed.tenant,
      actorId: f.outsider,
      requestId: "00000000-0000-7000-8000-00000000ab01",
    };
    const rows = await withTenant(
      f.db.rw,
      ctx,
      (tx) => tx<{ n: string }[]>`select count(*)::text as n from app.employee_sensitive`,
    );
    expect(rows[0]!.n).toBe("0");
  });

  it("and every row for the holder — the gate is a predicate, not an empty table", async () => {
    const ctx = {
      tenantId: f.seed.tenant,
      actorId: f.officer,
      requestId: "00000000-0000-7000-8000-00000000ab02",
    };
    const rows = await withTenant(
      f.db.rw,
      ctx,
      (tx) => tx<{ n: string }[]>`select count(*)::text as n from app.employee_sensitive`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  /** The export channel (8A Task 14, contracts round 16 A20). The branch is `7C-FIRST`: 7C's registry is in the
   *  tree, so the case runs unconditionally — the plan's namespace-import skip existed only for `8A-FIRST`. */
  const GATED_8A = [
    ["employee_sensitive", "hr.employee.read_sensitive"],
    ["employee_statutory_profile", "hr.compensation.read"],
    ["compensation_line", "hr.compensation.read"],
    ["pay_component", "hr.compensation.read"],
    ["pay_component_scheme", "hr.compensation.read"],
    ["statutory_scheme", "hr.statutory_table.manage"],
    ["statutory_rate_table", "hr.statutory_table.manage"],
  ] as const;

  it("the export archive carries none of 8A's gated tables for a non-holder, NAMES each one, and never a ciphertext column", async () => {
    // (a) the registry: each gate as decided, and no "*" pin left on a REGISTERED table.
    const byName = new Map(EXPORT_TABLES.map((t) => [t.name, t]));
    for (const [name, gate] of GATED_8A) {
      expect(byName.get(name)?.gate, name).toBe(gate);
      const forbidden = NEVER_EXPORTED[name] ?? [];
      expect(forbidden, name).not.toContain("*");
      for (const col of byName.get(name)!.columns)
        expect(forbidden, `${name}.${col}`).not.toContain(col);
    }
    // No ciphertext column is exportable, whatever the row says — the nine names come from the ONE list the
    // envelope iterates, so a tenth sensitive field cannot be forgotten here.
    for (const enc of SENSITIVE_FIELDS.map((c) => `${c}_enc`)) {
      expect(NEVER_EXPORTED["employee_sensitive"], enc).toContain(enc);
      expect(byName.get("employee_sensitive")!.columns, enc).not.toContain(enc);
    }
    // (b) a principal holding none of the codes: every 8A table ABSENT and NAMED with its gate.
    const outsider = {
      tenantId: f.seed.tenant,
      actorId: f.outsider,
      requestId: "00000000-0000-7000-8000-00000000ab03",
    };
    const { included, excluded } = await withTenant(f.db.rw, outsider, (tx) =>
      resolveExportGates(tx, { principalId: f.outsider, companyId: f.companyId }),
    );
    for (const [name, gate] of GATED_8A) {
      expect(
        included.map((t) => t.name),
        name,
      ).not.toContain(name);
      expect(excluded, name).toContainEqual({ table: name, gate });
    }
    // (c) the officer, who holds the codes, DOES get them: the gate is a predicate, not a permanent exclusion.
    const officer = {
      tenantId: f.seed.tenant,
      actorId: f.officer,
      requestId: "00000000-0000-7000-8000-00000000ab04",
    };
    const forOfficer = await withTenant(f.db.rw, officer, (tx) =>
      resolveExportGates(tx, { principalId: f.officer, companyId: f.companyId }),
    );
    expect(forOfficer.included.map((t) => t.name)).toEqual(
      expect.arrayContaining(GATED_8A.map(([name]) => name)),
    );
    // (d) what the exporter (the tenant's system principal) actually writes for employee_sensitive: metadata only —
    // the declared columns, no ciphertext, and no plaintext the earlier cases stored.
    const system = {
      tenantId: f.seed.tenant,
      actorId: f.seed.system,
      requestId: "00000000-0000-7000-8000-00000000ab05",
    };
    const rows = await withTenant(f.db.rw, system, (tx) =>
      exportTable("employee_sensitive").rows(tx, f.companyId, EVERY_ROW),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual([...exportTable("employee_sensitive").columns]);
      expect(JSON.stringify(row)).not.toContain("SYNTHETIC-TAX-3");
    }
  });
});

/** Every JSON row of `table` that names one of `ids` in any column. */
function rowsNaming(files: Map<string, string>, table: string, ids: readonly string[]): string[] {
  return (files.get(`tables/${table}.json`) ?? "")
    .split("\n")
    .filter((line) => line !== "" && ids.some((id) => line.includes(id)));
}

/**
 * Test 32's export clause for the PAYROLL documents (Phase 8 review, 2026-11-08; ADR 0069's 8-review amendment). A
 * posted PAYROLL's lines are per-employee pay and a PAYROLL_PAYMENT's lines name each employee beside their net, so the
 * whole-ledger tables (`document`, `document_line`, `ledger_entry`, `ledger_entry_dimension`, `document_link`,
 * `allocation`, `bank_match`, `custom_field_value`, `document_event`, `attachment`) must not carry an `hr`-module
 * document's rows to a requester without `hr.payroll.read` — §4.5.8's own read code for that module. Before the fix
 * every one of those tables shipped them ungated.
 */
describe("test 32 — the export carries no hr document's rows without hr.payroll.read", () => {
  let db: Db;
  let s: Seed;
  let m: MoneyOutFixture;
  let paymentId: string;
  let journalId: string;
  let attachmentId: string;
  /** Every ledger row the two hr documents posted — `ledger_entry_dimension` names only its entry. */
  let hrEntryIds: string[] = [];
  const store = new MemoryObjectStore();
  const HR_ROW_TABLES = [
    "document",
    "document_line",
    "document_link",
    "document_event",
    "ledger_entry",
    "ledger_entry_dimension",
    "allocation",
    "bank_match",
    "custom_field_value",
    "attachment",
  ];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "T32Payroll");
    m = await moneyOutFixture(db, s);
    paymentId = await postPayrollPayment(db, s, m);
    // An ACCOUNTING document beside them: its rows must still leave, or the "fix" is just an empty ledger.
    const [cash] = await db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '1100'`;
    journalId = (
      await postJournal(
        db,
        s,
        [
          { account: cash!.id, debit: "77.0000" },
          { account: m.salariesPayableAccountId, credit: "77.0000" },
        ],
        { effectiveDate: "2026-01-20" },
      )
    ).documentId;
    // A payslip-shaped attachment on the run (ADR 0079 stores payslips exactly so).
    attachmentId = await uuidv7(db.admin);
    const bytes = new TextEncoder().encode("payslip E-0001");
    const key = objectKeyFor(s.tenant, attachmentId);
    await store.put(key, bytes, "application/pdf");
    await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "00000000-0000-7000-8000-00000000ab08" },
      (tx) => tx`
        insert into app.attachment
          (id, tenant_id, company_id, document_id, object_key, file_name, mime_type, byte_size, sha256)
        values (${attachmentId}, ${s.tenant}, ${s.company}, ${m.payrollDocumentId}, ${key},
                'payslip-E-0001.pdf', 'application/pdf', ${bytes.byteLength},
                ${createHash("sha256").update(bytes).digest()})`,
    );
    hrEntryIds = (
      await db.admin<{ id: string }[]>`
        select id::text as id from app.ledger_entry
         where document_id in (${m.payrollDocumentId}, ${paymentId})`
    ).map((r) => r.id);
    if (hrEntryIds.length === 0)
      throw new Error("the fixture's payroll documents posted no ledger rows");
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  const exportAs = async (requestedBy: string) => {
    const jobId = await seedExportJob(db, s, {
      format: "json",
      requestedBy,
      readableModules: ["accounting"],
    });
    const system: TenantContext = {
      tenantId: s.tenant,
      actorId: s.system,
      requestId: "00000000-0000-7000-8000-00000000ab06",
    };
    const job = (await withTenant(db.rw, system, (tx) => getExportJob(tx, jobId)))!;
    const result = await runExport((fn) => withTenant(db.rw, system, fn), store, {
      job,
      tenantId: s.tenant,
      generatedAt: "2026-02-01T00:00:00Z",
    });
    const tar = gunzipSync(Buffer.from(result.bytes));
    const files = new Map<string, string>();
    for (let at = 0; at + 512 <= tar.length;) {
      const name = tar
        .subarray(at, at + 100)
        .toString("utf8")
        .replace(/\0.*$/s, "");
      if (name === "") break;
      const size = parseInt(
        tar
          .subarray(at + 124, at + 135)
          .toString("ascii")
          .trim(),
        8,
      );
      files.set(name, tar.subarray(at + 512, at + 512 + size).toString("utf8"));
      at += 512 + Math.ceil(size / 512) * 512;
    }
    return { manifest: result.manifest, files };
  };

  const hrIds = () => [m.payrollDocumentId, paymentId, ...hrEntryIds];

  it("a requester without hr.payroll.read gets no row of a PAYROLL or PAYROLL_PAYMENT, and the manifest names each table", async () => {
    // m.payer holds the accounting payment codes and nothing HR — the accountant who may export the books.
    const holds = await withTenant(
      db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "00000000-0000-7000-8000-00000000ab07" },
      (tx) => tx<{ ok: boolean }[]>`
        select app.principal_has(${m.payer}::uuid, 'hr.payroll.read', ${s.company}::uuid, null) as ok`,
    );
    expect(holds[0]!.ok).toBe(false);
    const { manifest, files } = await exportAs(m.payer);

    for (const table of HR_ROW_TABLES) {
      expect(rowsNaming(files, table, hrIds()), table).toEqual([]);
    }
    // The payment's per-employee line ("E-0001 <name>") and the payslip's file name are nowhere in the archive.
    const everyFile = [...files.values()].join("\n");
    expect(everyFile).not.toContain("E-0001 ");
    expect(everyFile).not.toContain("payslip-E-0001.pdf");
    // The tables themselves are still there — an accounting document's rows leave — and the rows kept out are
    // NAMED, with the gate that would have admitted them.
    expect(rowsNaming(files, "ledger_entry", [journalId]).length).toBe(2);
    expect(rowsNaming(files, "document", [journalId]).length).toBe(1);
    for (const table of HR_ROW_TABLES.filter((t) => t !== "document_event")) {
      expect(manifest.excludedRows, table).toContainEqual({
        table,
        gate: "hr.payroll.read",
        module: "hr",
      });
    }
    // document_event is itself gated on admin.audit_log.read, which m.payer lacks: absent whole.
    expect(manifest.excluded).toContainEqual({
      table: "document_event",
      gate: "admin.audit_log.read",
    });
    // The payslip's bytes were never readable either (ADR 0070's recorded modules).
    expect(manifest.attachmentsOmitted).toContainEqual({
      id: attachmentId,
      reason: "module_not_readable",
    });
  });

  it("the payroll approver, who holds hr.payroll.read, gets every one of those rows — the gate is a predicate", async () => {
    const { manifest, files } = await exportAs(m.approver);
    expect(manifest.excludedRows).toEqual([]);
    for (const table of ["document", "document_line", "ledger_entry", "ledger_entry_dimension"]) {
      expect(rowsNaming(files, table, hrIds()).length, table).toBeGreaterThan(0);
    }
    expect(rowsNaming(files, "document_line", [paymentId]).length).toBeGreaterThan(0);
    expect(rowsNaming(files, "attachment", [m.payrollDocumentId]).length).toBe(1);
  });
});
