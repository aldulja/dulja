import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimReportRun,
  completeReportRun,
  createReportRun,
  failReportRun,
  getReportRun,
  listReportRuns,
  loadRunDefinition,
  reportObjectKeyFor,
} from "../../src/reports/run-store";
import { grantCodes, seedReportDefinition, seedTenantV2, type Seed } from "../fixtures";
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
  sort: [],
  layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
  tieOut: { kind: "none" },
};

describe("the report_run store — contracts §4.11.2, ADR 0067", () => {
  let db: Db;
  let s: Seed;
  let other: Seed;
  let definitionId: string;

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "run-store");
    other = await seedTenantV2(db, "run-store-other");
    definitionId = await seedReportDefinition(db, s, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
    // The list shows a run only to a holder of its definition's own read code (Phase 7 review, finding 4).
    await grantCodes(db, s, { codes: ["accounting.report.read"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  type Tx = Parameters<Parameters<typeof withTenant>[3]>[0];
  const asHuman = <T>(fn: (tx: Tx) => Promise<T>, seed: Seed = s) =>
    withTenant(db.rw, seed.tenant, seed.human, fn);
  const queued = (format: "pdf" | "xlsx" | "csv" = "csv", lang: "en" | "ar" = "en") =>
    asHuman((tx) =>
      createReportRun(tx, {
        companyId: s.company,
        reportDefinitionId: definitionId,
        parameters: {},
        format,
        lang,
      }),
    );

  it("derives the object key from ids alone (SAH-038)", () => {
    expect(
      reportObjectKeyFor(
        "01927f3a-0000-7000-8000-000000000001",
        "01927f3a-0000-7000-8000-0000000000aa",
        "pdf",
        2,
      ),
    ).toBe(
      "01927f3a-0000-7000-8000-000000000001/reports/01927f3a-0000-7000-8000-0000000000aa/2.pdf",
    );
  });

  it("creates a queued run, stamps requested_by, and reads it back", async () => {
    const run = await asHuman((tx) =>
      createReportRun(tx, {
        companyId: s.company,
        reportDefinitionId: definitionId,
        parameters: { fiscalPeriodId: s.period },
        format: "csv",
        lang: "en",
      }),
    );
    expect(run.status).toBe("queued");
    expect(run.requestedBy).toBe(s.human);
    expect(run.parameters).toEqual({ fiscalPeriodId: s.period });
    expect(run.objectKey).toBeNull();
    expect(run.sha256).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(await asHuman((tx) => getReportRun(tx, run.id))).toEqual(run);
    expect(await asHuman((tx) => getReportRun(tx, definitionId))).toBeNull();
  });

  it("a second tenant cannot read, load or claim the run", async () => {
    const run = await queued();
    expect(await asHuman((tx) => getReportRun(tx, run.id), other)).toBeNull();
    expect(await asHuman((tx) => loadRunDefinition(tx, run.id), other)).toBeNull();
    expect(await asHuman((tx) => claimReportRun(tx, run.id), other)).toBeNull();
    expect((await asHuman((tx) => getReportRun(tx, run.id)))!.status).toBe("queued");
  });

  it("loadRunDefinition returns the run and the stored definition JSON in one read", async () => {
    const run = await queued("csv", "ar");
    const loaded = await asHuman((tx) => loadRunDefinition(tx, run.id));
    expect(loaded!.run.id).toBe(run.id);
    expect(loaded!.run.lang).toBe("ar");
    expect(loaded!.definition).toEqual(DEF);
    // The company join, asserted: without it the render handler formats every money cell as `XXX 1,234.50`.
    expect(loaded!.baseCurrency).toBe("MYR");
  });

  it("claim moves queued → running exactly once — a pg-boss re-delivery gets null", async () => {
    const run = await queued();
    expect((await asHuman((tx) => claimReportRun(tx, run.id)))!.status).toBe("running");
    expect(await asHuman((tx) => claimReportRun(tx, run.id))).toBeNull();
  });

  it("complete records the artefact; the CHECK refuses a done run without one", async () => {
    const run = await queued("pdf");
    await asHuman((tx) => claimReportRun(tx, run.id));
    const sha = new Uint8Array(createHash("sha256").update("x").digest());
    await asHuman((tx) =>
      completeReportRun(tx, {
        runId: run.id,
        objectKey: reportObjectKeyFor(s.tenant, run.id, "pdf", 1),
        sha256: sha,
      }),
    );
    const done = await asHuman((tx) => getReportRun(tx, run.id));
    expect(done!.status).toBe("done");
    expect(done!.objectKey).toBe(reportObjectKeyFor(s.tenant, run.id, "pdf", 1));
    expect(done!.sha256).toBe(Buffer.from(sha).toString("hex"));
    expect(done!.finishedAt).not.toBeNull();
    expect(done!.error).toBeNull();

    await expect(
      asHuman(
        (tx) =>
          tx`update app.report_run set status = 'done', object_key = null, sha256 = null where id = ${run.id}`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("complete and fail move only a live run — a finished one stays as it finished", async () => {
    const run = await queued();
    await asHuman((tx) => claimReportRun(tx, run.id));
    const sha = new Uint8Array(createHash("sha256").update("y").digest());
    const objectKey = reportObjectKeyFor(s.tenant, run.id, "csv", 1);
    await asHuman((tx) => completeReportRun(tx, { runId: run.id, objectKey, sha256: sha }));
    await asHuman((tx) => failReportRun(tx, { runId: run.id, error: "ERR_INTERNAL: late" }));
    const after = await asHuman((tx) => getReportRun(tx, run.id));
    expect(after!.status).toBe("done");
    expect(after!.error).toBeNull();
  });

  it("fail records the reason; the CHECK refuses a failed run without one", async () => {
    const run = await queued();
    await asHuman((tx) =>
      failReportRun(tx, { runId: run.id, error: "ERR_REPORT_DATASET_UNKNOWN: dataset 'x' …" }),
    );
    const failed = await asHuman((tx) => getReportRun(tx, run.id));
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toContain("ERR_REPORT_DATASET_UNKNOWN");
    expect(failed!.finishedAt).not.toBeNull();

    await expect(
      asHuman((tx) => tx`update app.report_run set error = null where id = ${run.id}`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("lists newest first, keyset-paged without loss, and filters on status and format", async () => {
    const all = await asHuman((tx) =>
      listReportRuns(tx, { companyId: s.company, filters: [], limit: 100 }),
    );
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < all.length; i += 1)
      expect(all[i - 1]!.createdAt >= all[i]!.createdAt).toBe(true);

    // Walk the whole list two at a time: every row exactly once, in the same order.
    const walked: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (;;) {
      const page: Awaited<ReturnType<typeof listReportRuns>> = await asHuman((tx) =>
        listReportRuns(tx, { companyId: s.company, filters: [], limit: 2, cursor }),
      );
      walked.push(...page.map((r) => r.id));
      if (page.length < 2) break;
      cursor = { createdAt: page[1]!.createdAt, id: page[1]!.id };
    }
    expect(walked).toEqual(all.map((r) => r.id));

    const failed = await asHuman((tx) =>
      listReportRuns(tx, {
        companyId: s.company,
        filters: [{ field: "status", op: "eq", value: "failed" }],
        limit: 100,
      }),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.status === "failed")).toBe(true);
    const pdf = await asHuman((tx) =>
      listReportRuns(tx, {
        companyId: s.company,
        filters: [{ field: "format", op: "eq", value: "pdf" }],
        limit: 100,
      }),
    );
    expect(pdf.length).toBeGreaterThan(0);
    expect(pdf.every((r) => r.format === "pdf")).toBe(true);

    await expect(
      asHuman((tx) =>
        listReportRuns(tx, {
          companyId: s.company,
          filters: [{ field: "object_key", op: "eq", value: "x" }],
          limit: 10,
        }),
      ),
    ).rejects.toThrowError(/filter field 'object_key' is not filterable on report runs/);
    await expect(
      asHuman((tx) =>
        listReportRuns(tx, {
          companyId: s.company,
          filters: [{ field: "status", op: "like", value: "x" }],
          limit: 10,
        }),
      ),
    ).rejects.toThrowError(/supports only the 'eq' operator/);
  });

  it("lists nothing to a member who lacks the definition's own read code (7 review)", async () => {
    const member = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${member}, 'human', ${`human:run-store-member:${member}`}, 'member')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${member})`;
    });
    await grantCodes(db, s, { codes: ["accounting.report.export"], principalId: member });
    const seen = await withTenant(db.rw, s.tenant, member, (tx) =>
      listReportRuns(tx, { companyId: s.company, filters: [], limit: 100 }),
    );
    expect(seen).toEqual([]);
  });

  it("resolves the caller's read codes ONCE — never app.actor_has per run row — with the same result (7 second review, finding 6)", async () => {
    // A second definition on a code s.human does NOT hold, with runs of its own: the list must still drop them.
    const auditDefinition = await seedReportDefinition(db, s, {
      code: "accounting.audit_log",
      definition: {
        ...DEF,
        code: "accounting.audit_log",
        permission: "admin.audit_log.read",
        dataset: { source: "audit_log", filters: [] },
        columns: [
          { field: "seq", labelEn: "Seq", labelAr: "التسلسل", format: "text", align: "start" },
        ],
      },
    });
    const hidden = await asHuman((tx) =>
      createReportRun(tx, {
        companyId: s.company,
        reportDefinitionId: auditDefinition,
        parameters: {},
        format: "csv",
        lang: "en",
      }),
    );
    // Every tagged template the store issues, recorded through a proxy over the caller's transaction.
    const statements: string[] = [];
    const listed = await asHuman((tx) => {
      const spy = new Proxy(tx, {
        apply(target, self, args: unknown[]) {
          const strings = args[0];
          if (Array.isArray(strings) && "raw" in strings) statements.push(strings.join("$"));
          return Reflect.apply(target, self, args) as unknown;
        },
      });
      return listReportRuns(spy, { companyId: s.company, filters: [], limit: 1000 });
    });
    const listing = statements.filter((t) => t.includes("from app.report_run"));
    expect(listing).toHaveLength(1);
    expect(listing[0]).not.toContain("actor_has"); // no function call per row
    expect(statements.filter((t) => t.includes("actor_has"))).toHaveLength(1); // one resolution per call
    // The result is exactly the per-row predicate's: same rows, same order.
    const expected = await asHuman(
      (tx) => tx<{ id: string }[]>`
        select r.id from app.report_run r join app.report_definition d on d.id = r.report_definition_id
         where r.company_id = ${s.company}::uuid
           and app.actor_has(d.definition ->> 'permission', r.company_id, null::uuid)
         order by r.created_at desc, r.id desc`,
    );
    expect(listed.map((r) => r.id)).toEqual(expected.map((r) => r.id));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.map((r) => r.id)).not.toContain(hidden.id);
  });

  it("lists only the named company's runs, and nothing of another tenant's", async () => {
    expect(
      await asHuman(
        (tx) => listReportRuns(tx, { companyId: s.company, filters: [], limit: 10 }),
        other,
      ),
    ).toEqual([]);
  });
});
