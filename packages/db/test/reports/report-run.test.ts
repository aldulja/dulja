import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import { reportObjectKeyFor } from "../../src/reports/run-store";
import { seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

const DEF = {
  version: 1,
  code: "accounting.ledger",
  nameEn: "Ledger",
  nameAr: "دفتر الأستاذ",
  module: "accounting",
  permission: "accounting.report.read",
  parameters: [],
  dataset: { source: "ledger_entry", filters: [] },
  columns: [
    { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
  ],
  groups: [],
  totals: [],
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("app.report_run — contracts §4.11.2; the status resource spec:2206 requires", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let definitionId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "report-run-a");
    b = await seedTenantV2(db, "report-run-b");
    definitionId = await seedReportDefinition(db, a, {
      code: "accounting.ledger",
      definition: DEF,
    });
  });
  afterAll(async () => {
    await db.stop();
  });

  const insertRun = (format: string, lang: string, status: string) =>
    withTenant(db.rw, a.tenant, a.human, async (tx) => {
      const [row] = await tx<{ id: string; requested_by: string }[]>`
        insert into app.report_run (tenant_id, company_id, report_definition_id, format, lang, status)
        values (${a.tenant}, ${a.company}, ${definitionId}, ${format}, ${lang}, ${status})
        returning id, requested_by`;
      return row!;
    });

  it("carries every column §4.11.2 names", async () => {
    const cols = await db.migrator<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'report_run' order by column_name`;
    // `attempts` and `started_at` are the claim's lease (Phase 7 review, finding 2).
    expect(cols.map((c) => c.column_name)).toEqual([
      "attempts",
      "company_id",
      "created_at",
      "error",
      "finished_at",
      "format",
      "id",
      "lang",
      "object_key",
      "parameters",
      "report_definition_id",
      "requested_by",
      "saved_view_id",
      "sha256",
      "started_at",
      "status",
      "tenant_id",
    ]);
  });

  it("enforces the three closed vocabularies", async () => {
    await expect(insertRun("docx", "en", "queued")).rejects.toMatchObject({ code: "23514" });
    await expect(insertRun("pdf", "fr", "queued")).rejects.toMatchObject({ code: "23514" });
    await expect(insertRun("pdf", "en", "pending")).rejects.toMatchObject({ code: "23514" });
  });

  it("stamps requested_by from the session and refuses to have it re-written (ERR_ACTOR_IMMUTABLE)", async () => {
    const row = await insertRun("csv", "en", "queued");
    expect(row.requested_by).toBe(a.human);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.report_run set requested_by = ${a.system} where id = ${row.id}`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("ERR_ACTOR_IMMUTABLE"),
    });
    const triggers = await db.migrator<{ tgname: string }[]>`
      select tgname from pg_trigger where tgrelid = 'app.report_run'::regclass and not tgisinternal order by tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual(["audit_row", "stamp_requested_by"]);
  });

  it("makes 'done with nothing to download' and 'failed with no reason' unrepresentable", async () => {
    const { id } = await insertRun("xlsx", "en", "queued");
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.report_run set status = 'done', finished_at = now() where id = ${id}`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) =>
          tx`update app.report_run set status = 'failed', finished_at = now() where id = ${id}`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.report_run set status = 'failed', error = 'ERR_REPORT_DATASET_UNKNOWN: x',
                      finished_at = now() where id = ${id}`;
    });
  });

  it("moves queued → running → done and records the artefact", async () => {
    const { id } = await insertRun("pdf", "ar", "queued");
    // The key comes from the one composer (`reportObjectKeyFor`), never a template literal here: LEGACY-038's
    // source scan refuses an object key composed anywhere else.
    const key = reportObjectKeyFor(a.tenant, id, "pdf", 1);
    await withTenant(db.rw, a.tenant, a.human, async (tx) => {
      await tx`update app.report_run set status = 'running' where id = ${id}`;
      // `sha256(bytea)` is a PostgreSQL builtin and needs no extension; `digest()` would be pgcrypto, which
      // the schema never installs.
      await tx`update app.report_run
                  set status = 'done', object_key = ${key},
                      sha256 = sha256('x'::bytea), finished_at = now()
                where id = ${id}`;
    });
    const [done] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ status: string; object_key: string }[]>`
        select status, object_key from app.report_run where id = ${id}`,
    );
    expect(done).toEqual({ status: "done", object_key: key });
    // object_key is unique: two runs can never claim one artefact.
    const other = await insertRun("pdf", "ar", "queued");
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`update app.report_run set object_key = ${key}
                    where id = ${other.id}`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a second tenant cannot see it, nor point a run at another tenant's definition", async () => {
    const seen = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      async (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.report_run`,
    );
    expect(seen[0]!.n).toBe(0);
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (
          tx,
        ) => tx`insert into app.report_run (tenant_id, company_id, report_definition_id, format, lang)
                   values (${b.tenant}, ${b.company}, ${definitionId}, 'csv', 'en')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("app_rw cannot DELETE a run — the row is the audit trail of who exported what (ADR 0067)", async () => {
    const { id } = await insertRun("csv", "ar", "queued");
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) => tx`delete from app.report_run where id = ${id}`),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("reports zero linter violations", async () => {
    const violations = await lintSchema(db.admin);
    expect(violations.filter((v) => v.table === "report_run")).toEqual([]);
  });
});
