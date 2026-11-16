import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportSchemaDocument } from "../../src/export/schema";
import {
  EVERY_ROW,
  EXPORT_TABLES,
  MODULE_BOUNDED_TABLES,
  MODULE_ROW_GATES,
  NEVER_EXPORTED,
  exportTable,
  resolveExportGates,
  type ExportTable,
} from "../../src/export/tables";
import {
  arApReportFixture,
  type ArApReportFixture,
} from "../../../../tests/invariants/support/reports-7c";
import { grantCodes, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** Tables the registry pins before they exist: the slice that creates one narrows its pin (ADR 0069).
 *  Empty since 8A's migration 0081 created `employee_sensitive`; its whole-table pin stands until 8A Task 14
 *  narrows it to the nine ciphertext columns and registers the gated metadata row (contracts round 16, A20). */
const FORWARD_PINS: readonly string[] = [];
const GATE_PATTERN = /^[a-z_]+\.[a-z_]+\.[a-z_]+$/;

/** A registry entry with some members replaced, to prove what `exportSchemaDocument` refuses. */
const fake = (overrides: Partial<ExportTable>): ExportTable => ({
  ...exportTable("principal"),
  ...overrides,
});

describe("the export table registry — ADR 0069, spec:2186, tests 32 and 36", () => {
  let db: Db;
  let f: ArApReportFixture;
  let other: Seed;
  let secondCompany: string;
  let gated: string; // holds admin.data.export only
  let full: string; // holds admin.data.export AND every gate EXPORT_TABLES declares
  let narrowed: string; // holds every gate, but through a branch-narrowed assignment
  let live: Map<string, Set<string>>;

  const gates = [...new Set(EXPORT_TABLES.flatMap((t) => (t.gate === null ? [] : [t.gate])))];

  beforeAll(async () => {
    db = await startDb();
    f = await arApReportFixture(db, "export-tables");
    other = await seedTenantV2(db, "export-tables-b");
    gated = await uuidv7(db.admin);
    full = await uuidv7(db.admin);
    narrowed = await uuidv7(db.admin);
    await withTenant(db.migrator, f.s.tenant, f.s.system, async (tx) => {
      for (const [id, label] of [
        [gated, "gated"],
        [full, "full"],
        [narrowed, "narrowed"],
      ] as const) {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`human:${label}:${f.s.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${f.s.tenant}, ${id})`;
      }
    });
    await grantCodes(db, f.s, { codes: ["admin.data.export"], principalId: gated });
    // The list is the registry's own, so a gate a later slice adds is granted here without an edit.
    await grantCodes(db, f.s, { codes: ["admin.data.export", ...gates], principalId: full });
    await grantCodes(db, f.s, {
      codes: ["admin.data.export", ...gates],
      principalId: narrowed,
      branchIds: [f.s.hq],
    });
    // A second company in the same tenant, created directly (§4.17 has no seedCompany helper): the job runs
    // as the system principal, so every company-scoped query's own predicate is the only thing between it
    // and this company's rows.
    secondCompany = await withTenant(db.rw, f.s.tenant, f.s.human, async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${f.s.tenant}, 'EXP-B', 'Export second company', 'MYR') returning id`;
      return row!.id;
    });
    const columns = await db.admin<{ table_name: string; column_name: string }[]>`
      select c.table_name, c.column_name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema = 'app'`;
    live = new Map();
    for (const row of columns) {
      const set = live.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      live.set(row.table_name, set);
    }
  });
  afterAll(async () => {
    await db.stop();
  });

  const read = <T>(fn: (tx: Sql) => Promise<T>, s: Seed = f.s, actor = f.reader) =>
    withTenant(db.rw, s.tenant, actor, fn);

  it("every registered table declares explicit columns, a unique name and a well-formed gate", () => {
    const names = EXPORT_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of EXPORT_TABLES) {
      expect(t.columns.length, t.name).toBeGreaterThan(0);
      expect(new Set(t.columns).size, t.name).toBe(t.columns.length);
      expect(t.gate === null || GATE_PATTERN.test(t.gate), t.name).toBe(true);
    }
    expect(EXPORT_TABLES.some((t) => t.gate !== null)).toBe(true);
    expect(exportTable("document").name).toBe("document");
    expect(() => exportTable("no_such_table")).toThrow(/no_such_table/);
  });

  it("every app table is classified: registered, or pinned whole in NEVER_EXPORTED — never both, never neither", () => {
    const registered = new Set(EXPORT_TABLES.map((t) => t.name));
    const pinnedWhole = new Set(
      Object.entries(NEVER_EXPORTED)
        .filter(([, cols]) => cols.includes("*"))
        .map(([name]) => name),
    );
    const unclassified = [...live.keys()].filter((n) => !registered.has(n) && !pinnedWhole.has(n));
    expect(unclassified, "a table nobody has reasoned about").toEqual([]);
    expect([...registered].filter((n) => pinnedWhole.has(n))).toEqual([]);
    // Every registered table and every pin names a real table, save the declared forward pins.
    for (const name of registered) expect(live.has(name), name).toBe(true);
    for (const name of Object.keys(NEVER_EXPORTED))
      expect(live.has(name) || FORWARD_PINS.includes(name), name).toBe(true);
    for (const name of FORWARD_PINS) {
      expect(live.has(name), `${name} now exists: narrow its pin`).toBe(false);
      expect(NEVER_EXPORTED[name]).toEqual(["*"]);
    }
  });

  it("no registered column is pinned, and every column pin names a live column (the side-channel list)", () => {
    for (const t of EXPORT_TABLES) {
      const forbidden = NEVER_EXPORTED[t.name] ?? [];
      for (const c of t.columns) expect(forbidden, `${t.name}.${c}`).not.toContain(c);
    }
    for (const [name, cols] of Object.entries(NEVER_EXPORTED)) {
      if (cols.includes("*")) {
        expect(cols, name).toEqual(["*"]);
        continue;
      }
      for (const c of cols) expect(live.get(name)?.has(c), `${name}.${c}`).toBe(true);
    }
    // The pins themselves: a future edit that "just adds one useful column" fails here.
    expect(NEVER_EXPORTED["principal"]).toContain("auth_subject");
    expect(NEVER_EXPORTED["pos_cashier"]).toContain("pin_hash");
    expect(NEVER_EXPORTED["pos_terminal"]).toContain("device_public_key");
    expect(NEVER_EXPORTED["company"]).toEqual(
      expect.arrayContaining(["einvoice_client_id", "einvoice_credential_ref"]),
    );
    expect(NEVER_EXPORTED["needs_attention"]).toContain("payload");
    expect(NEVER_EXPORTED["attachment"]).toContain("object_key");
    expect(NEVER_EXPORTED["report_run"]).toContain("object_key");
    expect(NEVER_EXPORTED["audit_log"]).toEqual(expect.arrayContaining(["before", "after"]));
    for (const whole of [
      "terminal_enrolment",
      "idempotency_key",
      "terminal_request_guard",
      "export_job",
    ]) {
      expect(NEVER_EXPORTED[whole], whole).toEqual(["*"]);
      expect(EXPORT_TABLES.map((t) => t.name)).not.toContain(whole);
    }
    // No credential-shaped column leaves under any name.
    for (const t of EXPORT_TABLES)
      for (const c of t.columns)
        expect(c, `${t.name}.${c}`).not.toMatch(/(_hash|_key|secret)$|^pin$/);
  });

  it("every query returns exactly the declared columns, in order — empty tables included", async () => {
    for (const t of EXPORT_TABLES) {
      const rows = await read((tx) => t.rows(tx, f.s.company, EVERY_ROW));
      // postgres.js reports the result's columns even for zero rows, so no table is skipped.
      const names = (rows as unknown as { columns: { name: string }[] }).columns.map((c) => c.name);
      expect(names, t.name).toEqual([...t.columns]);
      for (const row of rows) expect(Object.keys(row), t.name).toEqual([...t.columns]);
    }
  });

  it("the fixture's books are in the export, wire-shaped (fixed-decimal money, RFC 3339 timestamps)", async () => {
    const ledger = await read((tx) => exportTable("ledger_entry").rows(tx, f.s.company, EVERY_ROW));
    expect(ledger.length).toBeGreaterThan(0);
    for (const row of ledger) {
      expect(row["base_debit"]).toMatch(/^-?\d+\.\d{4}$/);
      expect(row["posted_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(row["effective_date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const company = await read((tx) => exportTable("company").rows(tx, f.s.company, EVERY_ROW));
    expect(company.map((r) => r["id"])).toEqual([f.s.company]);
    const principals = await read((tx) =>
      exportTable("principal").rows(tx, f.s.company, EVERY_ROW),
    );
    expect(principals.map((r) => r["id"])).toContain(f.reader);
  });

  it("a company-scoped query never reaches another company of the same tenant", async () => {
    for (const t of EXPORT_TABLES.filter((x) => x.scope === "company")) {
      const rows = await read((tx) => t.rows(tx, secondCompany, EVERY_ROW));
      // The company row itself is the one row a company's export of an empty company holds.
      if (t.name === "company") expect(rows.map((r) => r["id"])).toEqual([secondCompany]);
      else expect(rows, t.name).toEqual([]);
    }
    // The tenant-scoped set is closed and deliberate: the currency list, the members and their roles, and
    // the audit trail.
    expect(
      EXPORT_TABLES.filter((t) => t.scope === "tenant")
        .map((t) => t.name)
        .toSorted(),
    ).toEqual([
      "audit_log",
      "currency",
      "membership",
      "principal",
      "role",
      "role_permission",
      "tenant",
    ]);
  });

  it("a second tenant sees none of the first tenant's rows through any query (test 12)", async () => {
    const own = new Set<unknown>();
    for (const t of EXPORT_TABLES) {
      const rows = await read((tx) => t.rows(tx, f.s.company, EVERY_ROW));
      for (const row of rows) if (row["id"] !== undefined) own.add(row["id"]);
    }
    for (const t of EXPORT_TABLES) {
      const rows = await read((tx) => t.rows(tx, f.s.company, EVERY_ROW), other, other.human);
      if (t.scope === "company") expect(rows, t.name).toEqual([]);
      for (const row of rows) expect(own.has(row["id"]), `${t.name} ${row["id"]}`).toBe(false);
    }
  });

  it("a requester without a table's gate gets that table EXCLUDED and NAMED (test 32's mechanism)", async () => {
    const forGated = await read((tx) =>
      resolveExportGates(tx, { principalId: gated, companyId: f.s.company }),
    );
    const excluded = forGated.excluded.map((e) => e.table);
    expect(excluded).toEqual(EXPORT_TABLES.filter((t) => t.gate !== null).map((t) => t.name));
    expect(excluded).toEqual(
      expect.arrayContaining(["audit_log", "tax_transaction", "cost_layer"]),
    );
    for (const e of forGated.excluded) {
      expect(e.gate, e.table).toMatch(GATE_PATTERN);
      expect(e.gate).toBe(exportTable(e.table).gate);
    }
    expect(forGated.included.map((t) => t.name)).not.toContain("audit_log");

    const forFull = await read((tx) =>
      resolveExportGates(tx, { principalId: full, companyId: f.s.company }),
    );
    expect(forFull.excluded).toEqual([]);
    expect(forFull.included.map((t) => t.name)).toEqual(EXPORT_TABLES.map((t) => t.name));

    // A branch-narrowed assignment holds no company-wide gate (app.principal_has(…, null), test 36).
    const forNarrowed = await read((tx) =>
      resolveExportGates(tx, { principalId: narrowed, companyId: f.s.company }),
    );
    expect(forNarrowed.excluded.map((e) => e.table)).toEqual(excluded);
    // A gate is per company: holding it in this company says nothing about the second one.
    const elsewhere = await read((tx) =>
      resolveExportGates(tx, { principalId: full, companyId: secondCompany }),
    );
    expect(elsewhere.excluded.map((e) => e.table)).toEqual(excluded);
  });

  it("report_run is audit information: gated on admin.audit_log.read, never on the export code alone, and its lease stays behind (7 second review, finding 3)", async () => {
    // The runs list shows a run only to a holder of its definition's read code; the export gated the whole
    // table on accounting.report.export, so an export-code holder received every run in the company.
    const exporter = await uuidv7(db.admin);
    await withTenant(db.migrator, f.s.tenant, f.s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${exporter}, 'human', ${`human:report-exporter:${f.s.tenant}`}, 'report exporter')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${f.s.tenant}, ${exporter})`;
    });
    await grantCodes(db, f.s, {
      codes: ["admin.data.export", "accounting.report.export"],
      principalId: exporter,
    });
    const resolved = await read((tx) =>
      resolveExportGates(tx, { principalId: exporter, companyId: f.s.company }),
    );
    expect(resolved.included.map((t) => t.name)).not.toContain("report_run");
    expect(resolved.excluded).toContainEqual({ table: "report_run", gate: "admin.audit_log.read" });
    expect(exportTable("report_run").gate).toBe("admin.audit_log.read");
    // The lease columns are classified deliberately: pinned as plumbing, not silently omitted.
    expect(NEVER_EXPORTED["report_run"]).toEqual(
      expect.arrayContaining(["object_key", "started_at", "attempts"]),
    );
    for (const column of ["started_at", "attempts"]) {
      expect(live.get("report_run")!.has(column), column).toBe(true);
      expect(exportTable("report_run").columns).not.toContain(column);
    }
    expect(NEVER_EXPORTED["export_job"]).toEqual(["*"]);
  });

  it("a document-keyed table is module-bounded, or gated on a module code, or named here with its reason (Phase 8 review)", async () => {
    // Every registered table with a foreign key to app.document. A table that holds a document's rows and is
    // neither bounded nor gated would carry a PAYROLL's rows to an exporter without hr.payroll.read — the defect
    // the Phase 8 review closed for the whole-ledger tables.
    const keyed = await db.admin<{ table_name: string }[]>`
      select distinct cl.relname as table_name
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid
        join pg_namespace ns on ns.oid = cl.relnamespace
       where con.contype = 'f' and ns.nspname = 'app' and con.confrelid = 'app.document'::regclass`;
    const moduleGates = new Set(Object.values(MODULE_ROW_GATES));
    // Tables whose rows only ever belong to a non-`hr` module's documents (their writers are inventory, tax, e-invoice
    // and till code), each gated by its own module's code already.
    const NON_HR_ONLY = new Set([
      "cost_layer",
      "cost_consumption",
      "inventory_movement",
      "landed_cost_allocation",
      "tax_transaction",
      "einvoice_transmission",
      "till_event",
      "till_banking_link",
      "needs_attention",
      "shift",
    ]);
    const registered = new Set(EXPORT_TABLES.map((t) => t.name));
    for (const { table_name: name } of keyed) {
      if (!registered.has(name)) continue; // pinned whole, or not an export table at all
      const table = exportTable(name);
      const ok =
        table.moduleRows ||
        (table.gate !== null && moduleGates.has(table.gate)) ||
        NON_HR_ONLY.has(name);
      expect(ok, `${name} holds document rows but is neither module-bounded nor hr-gated`).toBe(
        true,
      );
    }
    for (const name of MODULE_BOUNDED_TABLES) expect(exportTable(name).moduleRows, name).toBe(true);
  });

  it("with every module hidden, no module-bounded table returns a row that names a document", async () => {
    const modules = await db.admin<{ module: string }[]>`
      select distinct dt.module::text as module from app.document d
        join app.document_type dt on dt.id = d.document_type_id where d.company_id = ${f.s.company}`;
    const ids = await db.admin<{ id: string }[]>`
      select id::text as id from app.document where company_id = ${f.s.company}`;
    expect(ids.length).toBeGreaterThan(0);
    const scope = { hiddenModules: modules.map((m) => m.module) };
    for (const t of EXPORT_TABLES.filter((x) => x.moduleRows)) {
      const unbounded = await read((tx) => t.rows(tx, f.s.company, EVERY_ROW));
      const bounded = await read((tx) => t.rows(tx, f.s.company, scope));
      const leaked = bounded.filter((row) => ids.some(({ id }) => Object.values(row).includes(id)));
      expect(leaked, t.name).toEqual([]);
      if (["document", "document_line", "ledger_entry"].includes(t.name))
        expect(unbounded.length, t.name).toBeGreaterThan(0); // the bound removed real rows
    }
  });

  it("schema.json documents every included table and every omitted column", async () => {
    const doc = await read((tx) =>
      exportSchemaDocument(tx, {
        companyId: f.s.company,
        tables: EXPORT_TABLES,
        generatedAt: "2026-02-01T00:00:00Z",
      }),
    );
    expect(doc.formatVersion).toBe(1);
    expect(doc.moneyScale).toBe(4);
    expect(doc.csvDialect).toEqual({ delimiter: ",", quote: '"', newline: "\n", header: true });
    expect(doc.tables.map((t) => t.name)).toEqual(EXPORT_TABLES.map((t) => t.name));
    for (const t of doc.tables) {
      const liveNames = live.get(t.name)!;
      for (const c of t.columns) expect(liveNames.has(c.name), `${t.name}.${c.name}`).toBe(true);
      for (const name of liveNames) {
        const known = t.columns.some((c) => c.name === name) || t.omitted.includes(name);
        expect(known, `${t.name}.${name} is neither exported nor listed as omitted`).toBe(true);
      }
      for (const pinned of NEVER_EXPORTED[t.name] ?? [])
        expect(t.omitted, `${t.name}.${pinned}`).toContain(pinned);
    }
    const ledger = doc.tables.find((t) => t.name === "ledger_entry")!;
    expect(ledger.columns.find((c) => c.name === "base_debit")).toEqual({
      name: "base_debit",
      type: "numeric",
      nullable: false,
      scale: 4,
    });
    expect(ledger.columns.find((c) => c.name === "exchange_rate")!.scale).toBe(8);
    expect(doc.tables.find((t) => t.name === "document_line")!.omitted).toContain("cost");
  });

  it("schema.json refuses a pinned table, a pinned column and a column the database lacks", async () => {
    const doc = (table: ExportTable) =>
      read((tx) =>
        exportSchemaDocument(tx, { companyId: f.s.company, tables: [table], generatedAt: "x" }),
      );
    await expect(doc(fake({ name: "idempotency_key", columns: ["key"] }))).rejects.toThrow(
      /pinned whole/,
    );
    await expect(doc(fake({ columns: ["id", "auth_subject"] }))).rejects.toThrow(
      /auth_subject is in NEVER_EXPORTED/,
    );
    await expect(doc(fake({ columns: ["id", "nickname"] }))).rejects.toThrow(
      /has no column 'nickname'/,
    );
  });
});
