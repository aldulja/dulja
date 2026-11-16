import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { seedExportJob, seedTenantV2, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("app.export_job — contracts §4.6.1, 7C amendment A9", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "export-a");
    b = await seedTenantV2(db, "export-b");
  });
  afterAll(async () => {
    await db.stop();
  });

  it("the schema linter reports zero violations after 0078 (§3.5.2)", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("carries the columns amendment A9 fixes, with the three-value format CHECK", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'export_job' order by column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(
      [
        "attempts",
        "byte_size",
        "company_id",
        "created_at",
        "error",
        "finished_at",
        "format",
        "id",
        "include_attachments",
        "lot_attachments",
        "manifest",
        "object_key",
        "readable_modules",
        "requested_by",
        "row_count",
        "sha256",
        "started_at",
        "status",
        "table_count",
        "tenant_id",
      ].toSorted(),
    );
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));
    expect(byName.get("readable_modules")).toBe("ARRAY");
    expect(byName.get("sha256")).toBe("bytea");
    expect(byName.get("manifest")).toBe("jsonb");
    expect(byName.get("row_count")).toBe("bigint");
    const [check] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.export_job'::regclass and conname = 'export_job_format_check'`;
    expect(check!.def).toContain("'both'");
  });

  it("refuses a fourth format, a module outside §3.6.1's five, and a done row with no artefact", async () => {
    const insert = (format: string, modules: string[], status = "queued") =>
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (
          tx,
        ) => tx`insert into app.export_job (tenant_id, company_id, format, status, readable_modules)
          values (${a.tenant}, ${a.company}, ${format}, ${status}, ${modules}::text[])`,
      );
    await expect(insert("xlsx", [])).rejects.toThrow(/export_job_format_check/);
    await expect(insert("both", ["payroll"])).rejects.toThrow(/export_job_readable_modules_closed/);
    await expect(insert("both", [], "done")).rejects.toThrow(/export_job_/);
  });

  it("requested_by is stamped by the server, never by the caller (§3.3)", async () => {
    const id = await seedExportJob(db, a);
    const [row] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ requested_by: string }[]>`select requested_by from app.export_job where id = ${id}`,
    );
    expect(row!.requested_by).toBe(a.human);
    // A caller who names someone else is overwritten, not obeyed.
    const id2 = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`insert into app.export_job (id, tenant_id, company_id, requested_by, format)
         values (${id2}, ${a.tenant}, ${a.company}, ${a.system}, 'both')`,
    );
    const [row2] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<{ requested_by: string }[]>`select requested_by from app.export_job where id = ${id2}`,
    );
    expect(row2!.requested_by).toBe(a.human);
  });

  it("every write is audited (test 13, spec:106)", async () => {
    const id = await seedExportJob(db, a);
    const rows = await db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log
       where table_name = 'export_job' and row_id = ${id} order by seq`;
    expect(rows.map((r) => r.action)).toEqual(["insert"]);
    expect(rows[0]!.actor_id).toBe(a.human);
  });

  it("a second tenant cannot see it (§3.3 Always, test 12)", async () => {
    const id = await seedExportJob(db, a);
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ id: string }[]>`select id from app.export_job where id = ${id}`,
    );
    expect(seen).toEqual([]);
  });

  it("seedExportJob writes every status the outcome CHECK admits", async () => {
    for (const status of ["queued", "running", "done", "failed"] as const) {
      const id = await seedExportJob(db, a, { status, format: "csv" });
      const [row] = await db.admin<{ status: string; format: string }[]>`
        select status, format from app.export_job where id = ${id}`;
      expect(row).toEqual({ status, format: "csv" });
    }
  });

  it("app_rw holds no DELETE on it — the pinned list is unchanged (§3.5.4, hazard 25)", async () => {
    const rows = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'export_job'
       order by privilege_type`;
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
