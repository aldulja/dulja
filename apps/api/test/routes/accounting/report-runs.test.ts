import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import {
  createJobClient,
  JOB_NAMES,
  REPORT_RUN_JOB_OPTIONS,
  REPORT_RUN_LEASE_SECONDS,
  REPORT_RUN_MAX_CLAIMS,
  reportObjectKeyFor,
  type JobClient,
} from "@dulja/db";
import {
  grantCodes,
  installBoss,
  seedReportDefinition,
  seedTenantV2,
  stopBoss,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { REPO_ROOT } from "../../../../../tests/support/source";
import { startApi, type StartedApi } from "../../support/app";

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
/** The two codes spec:2163 gives the `auditor`: neither is mutating, which is the R7 point of the POST's gate. */
const EXPORTER = ["accounting.report.read", "accounting.report.export"];

/**
 * A REAL pg-boss behind the API's job client (startApi's stub refuses `reporting.render`), so the tests can
 * see the job the POST enqueued on its own transaction. `failNext` makes the next enqueue throw, to prove the
 * run row rolls back with it.
 */
function bossBackedJobs() {
  const state: { real?: JobClient; failNext: boolean } = { failNext: false };
  const jobs: JobClient = {
    enqueue: (tx, name, job, options) => {
      if (state.failNext) {
        state.failNext = false;
        return Promise.reject(new Error("simulated enqueue failure"));
      }
      if (!state.real) throw new Error("pg-boss is not installed yet");
      return state.real.enqueue(tx, name, job, options);
    },
  };
  return { state, jobs };
}

describe("POST /v1/companies/{companyId}/reports/{code}/runs — contracts §4.11.2", () => {
  let api: StartedApi;
  let boss: Awaited<ReturnType<typeof installBoss>> | undefined;
  const { state, jobs } = bossBackedJobs();
  let s: Seed;
  let other: Seed;
  let definitionId: string;

  beforeAll(async () => {
    api = await startApi({ jobs });
    boss = await installBoss(api.db, JOB_NAMES);
    state.real = createJobClient(boss);
    s = await seedTenantV2(api.db, "runs-api");
    other = await seedTenantV2(api.db, "runs-api-other");
    await grantCodes(api.db, s, { codes: EXPORTER });
    definitionId = await seedReportDefinition(api.db, s, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
    await api.loadPrincipals();
  }, 240_000);
  afterAll(async () => {
    if (boss) await stopBoss(boss);
    await api.stop();
  });

  const post = (body: unknown, as = s.human, code = "accounting.trial_balance", seed = s) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${seed.company}/reports/${code}/runs`,
      body,
      as,
    });
  const runCount = async () =>
    (
      await api.db.admin<
        { n: number }[]
      >`select count(*)::int as n from app.report_run where tenant_id = ${s.tenant}`
    )[0]!.n;

  it("returns 202 with the run id, the job id and the run's own status URL — to a principal holding no mutating code", async () => {
    const res = await post({ parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; jobId: string; statusUrl: string };
    expect(body.runId).toMatch(/^[0-9a-f-]{36}$/);
    // ADR 0067: §4.11.2's literal "/v1/jobs/<jobId>" is replaced by the run resource. 9B mounts /v1/jobs/{jobId}
    // (round 20 C2), but only for a job with no resource of its own — a report run keeps its own.
    expect(body.statusUrl).toBe(`/v1/companies/${s.company}/report-runs/${body.runId}`);
    const status = await api.request({ method: "GET", path: body.statusUrl, as: s.human });
    expect(status.status).toBe(200);
    const run = (await status.json()) as Record<string, unknown>;
    expect(run).toMatchObject({
      id: body.runId,
      companyId: s.company,
      reportDefinitionId: definitionId,
      parameters: { fiscalPeriodId: s.period },
      format: "csv",
      lang: "en",
      status: "queued",
      requestedBy: s.human,
      sha256: null,
      error: null,
    });
    expect(run).not.toHaveProperty("objectKey");

    // The job is committed with the run and carries the run id and the caller's tenant, nothing else.
    const [job] = await api.db.admin<
      {
        data: { tenantId: string; payload: unknown };
        expire_seconds: number;
        retry_limit: number;
      }[]
    >`
      select data, expire_seconds, retry_limit from pgboss.job
       where name = 'reporting.render' and id = ${body.jobId}::uuid`;
    expect(job!.data.tenantId).toBe(s.tenant);
    expect(job!.data.payload).toEqual({ runId: body.runId });
    // The lease's options, stated (Phase 7 review, finding 2): a delivery whose worker died expires after the
    // lease and is redelivered — with a retry left for every claim plus the one that fails an abandoned run.
    expect(job!.expire_seconds).toBe(REPORT_RUN_LEASE_SECONDS);
    expect(job!.retry_limit).toBe(REPORT_RUN_JOB_OPTIONS.retryLimit);
    expect(job!.retry_limit).toBeGreaterThan(REPORT_RUN_MAX_CLAIMS);
  });

  it("a failed enqueue rolls the run back with it — neither a run nor a job survives", async () => {
    const before = await runCount();
    state.failNext = true;
    const res = await post({ parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" });
    expect(res.status).toBe(500);
    expect(await runCount()).toBe(before);
  });

  it("resolves {code} to the highest non-archived version, and accepts an explicit id", async () => {
    const v2 = await seedReportDefinition(api.db, s, {
      code: "accounting.trial_balance",
      definitionVersion: 2,
      definition: { ...DEF, nameEn: "Trial balance v2" },
    });
    const res = await post({ parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" });
    const runId = ((await res.json()) as { runId: string }).runId;
    const run = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/report-runs/${runId}`,
      as: s.human,
    });
    expect(((await run.json()) as { reportDefinitionId: string }).reportDefinitionId).toBe(v2);

    const pinned = await post({
      reportDefinitionId: definitionId,
      parameters: { fiscalPeriodId: s.period },
      format: "csv",
      lang: "en",
    });
    expect(pinned.status).toBe(202);
    const pinnedRunId = ((await pinned.json()) as { runId: string }).runId;
    const pinnedRun = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/report-runs/${pinnedRunId}`,
      as: s.human,
    });
    expect(((await pinnedRun.json()) as { reportDefinitionId: string }).reportDefinitionId).toBe(
      definitionId,
    );

    // An archived version is never picked, and a pinned id must name a definition of THIS code.
    await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.report_definition set archived_at = now() where id = ${v2}`,
    );
    const after = await post({
      parameters: { fiscalPeriodId: s.period },
      format: "csv",
      lang: "en",
    });
    const afterRun = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/report-runs/${((await after.json()) as { runId: string }).runId}`,
      as: s.human,
    });
    expect(((await afterRun.json()) as { reportDefinitionId: string }).reportDefinitionId).toBe(
      definitionId,
    );
    const wrongCode = await post(
      { reportDefinitionId: definitionId, parameters: {}, format: "csv", lang: "en" },
      s.human,
      "accounting.ledger",
    );
    expect(wrongCode.status).toBe(404);
  });

  it("404s an unknown code and another tenant's definition id, without revealing either", async () => {
    const unknown = await problemOf(
      await post(
        { parameters: {}, format: "csv", lang: "en" },
        s.human,
        "accounting.general_ledger",
      ),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe("ERR_NOT_FOUND");
    const foreign = await seedReportDefinition(api.db, other, {
      code: "accounting.ledger",
      definition: { ...DEF, code: "accounting.ledger" },
    });
    const res = await post(
      { reportDefinitionId: foreign, parameters: {}, format: "csv", lang: "en" },
      s.human,
      "accounting.ledger",
    );
    expect(res.status).toBe(404);
  });

  it("refuses a missing required parameter, an undeclared one and a malformed id, each by JSON Pointer", async () => {
    const missing = await problemOf(await post({ parameters: {}, format: "csv", lang: "en" }));
    expect(missing.status).toBe(400);
    expect(missing.code).toBe("ERR_VALIDATION_FAILED");
    expect(missing.errors).toEqual([
      { path: "/parameters/fiscalPeriodId", message: "required parameter is missing" },
    ]);
    const extra = await problemOf(
      await post({
        parameters: { fiscalPeriodId: s.period, branchId: s.hq },
        format: "csv",
        lang: "en",
      }),
    );
    expect(extra.errors).toEqual([
      { path: "/parameters/branchId", message: "this report declares no such parameter" },
    ]);
    const malformed = await problemOf(
      await post({ parameters: { fiscalPeriodId: "2026-01" }, format: "csv", lang: "en" }),
    );
    expect(malformed.errors).toEqual([
      { path: "/parameters/fiscalPeriodId", message: "a period parameter is a UUID" },
    ]);
  });

  it("refuses a format, a language or a body field outside the closed vocabularies", async () => {
    for (const body of [
      { parameters: { fiscalPeriodId: s.period }, format: "docx", lang: "en" },
      { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "fr" },
      { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en", objectKey: "x" },
    ])
      expect((await problemOf(await post(body))).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("records a saved view only when it is a live view of the same definition the caller may open", async () => {
    const viewId = await uuidv7(api.db.admin);
    await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (
        tx,
      ) => tx`insert into app.saved_view (id, tenant_id, company_id, report_definition_id, name_en, parameters)
                 values (${viewId}, ${s.tenant}, ${s.company}, ${definitionId}, 'My TB', '{}'::jsonb)`,
    );
    const ok = await post({
      reportDefinitionId: definitionId,
      savedViewId: viewId,
      parameters: { fiscalPeriodId: s.period },
      format: "csv",
      lang: "en",
    });
    expect(ok.status).toBe(202);
    const run = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/report-runs/${((await ok.json()) as { runId: string }).runId}`,
      as: s.human,
    });
    expect(((await run.json()) as { savedViewId: string }).savedViewId).toBe(viewId);

    // A view of a DIFFERENT definition (the archived v2 resolves nothing; pin a fresh one) is refused.
    const ledgerDef = await seedReportDefinition(api.db, s, {
      code: "accounting.ledger",
      definition: { ...DEF, code: "accounting.ledger" },
    });
    const refused = await post(
      {
        reportDefinitionId: ledgerDef,
        savedViewId: viewId,
        parameters: { fiscalPeriodId: s.period },
        format: "csv",
        lang: "en",
      },
      s.human,
      "accounting.ledger",
    );
    expect(refused.status).toBe(404);
  });

  it("requires accounting.report.export — 403 before any definition is read, so no catalogue oracle", async () => {
    const bare = await seedTenantV2(api.db, "runs-api-bare");
    await api.loadPrincipals();
    const noCodes = await post(
      { parameters: {}, format: "csv", lang: "en" },
      bare.human,
      "accounting.trial_balance",
      bare,
    );
    expect(noCodes.status).toBe(403);

    const readOnly = await seedTenantV2(api.db, "runs-api-read");
    await grantCodes(api.db, readOnly, { codes: ["accounting.report.read"] });
    await seedReportDefinition(api.db, readOnly, {
      code: "accounting.trial_balance",
      definition: DEF,
    });
    await api.loadPrincipals();
    const problem = await problemOf(
      await post(
        { parameters: { fiscalPeriodId: readOnly.period }, format: "csv", lang: "en" },
        readOnly.human,
        "accounting.trial_balance",
        readOnly,
      ),
    );
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("accounting.report.export");
  });

  it("refuses a definition whose OWN read code the caller lacks, even with the export code", async () => {
    // The card's "…, module read codes": the gate is the DEFINITION's `permission` value, resolved from data
    // through `app.actor_has`, not a compile-time code on the route.
    const crossModule = await seedTenantV2(api.db, "runs-api-cross-module");
    await grantCodes(api.db, crossModule, { codes: EXPORTER, roleCode: "EXPORTER" });
    await seedReportDefinition(api.db, crossModule, {
      code: "inventory.stock_on_hand",
      definition: {
        ...DEF,
        code: "inventory.stock_on_hand",
        nameEn: "Stock on hand",
        nameAr: "المخزون المتاح",
        module: "inventory",
        permission: "inventory.stock.read",
        parameters: [],
        dataset: { source: "stock_on_hand", filters: [] },
        columns: [
          { field: "item_code", labelEn: "Item", labelAr: "الصنف", format: "text", align: "start" },
        ],
      },
    });
    await api.loadPrincipals();
    const problem = await problemOf(
      await post(
        { parameters: {}, format: "csv", lang: "en" },
        crossModule.human,
        "inventory.stock_on_hand",
        crossModule,
      ),
    );
    expect(problem.status).toBe(403);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("inventory.stock.read");
  });

  it("refuses to queue a STORED definition whose gate the store would refuse today — 400, no run, no job (7 second review, finding 8)", async () => {
    // Written straight to the table, as a row written before the gate rule existed (or by a path that bypassed
    // the store) would be: the audit trail under the weaker accounting.report.read, which the caller holds.
    const legacy = await seedTenantV2(api.db, "runs-api-legacy-gate");
    await grantCodes(api.db, legacy, { codes: EXPORTER, roleCode: "EXPORTER" });
    await seedReportDefinition(api.db, legacy, {
      code: "accounting.audit_log",
      definition: {
        ...DEF,
        code: "accounting.audit_log",
        nameEn: "Audit log",
        nameAr: "سجل التدقيق",
        parameters: [],
        dataset: { source: "audit_log", filters: [] },
        columns: [
          {
            field: "table_name",
            labelEn: "Table",
            labelAr: "الجدول",
            format: "text",
            align: "start",
          },
        ],
      },
    });
    await api.loadPrincipals();
    const count = async () =>
      (
        await api.db.admin<
          { n: number }[]
        >`select count(*)::int as n from app.report_run where tenant_id = ${legacy.tenant}`
      )[0]!.n;
    const problem = await problemOf(
      await post(
        { parameters: {}, format: "csv", lang: "en" },
        legacy.human,
        "accounting.audit_log",
        legacy,
      ),
    );
    expect(problem.status).toBe(400);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(
      /\/permission dataset 'audit_log' may be gated only on admin\.audit_log\.read/,
    );
    expect(await count()).toBe(0);
  });

  it("requires the Idempotency-Key header and replays the stored 202 on the same key", async () => {
    const path = `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`;
    const body = { parameters: { fiscalPeriodId: s.period }, format: "csv", lang: "en" };
    const missing = await api.request({
      method: "POST",
      path,
      body,
      as: s.human,
      idempotencyKey: null,
    });
    expect(((await missing.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const before = await runCount();
    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST",
      path,
      body,
      as: s.human,
      idempotencyKey: key,
    });
    const replay = await api.request({
      method: "POST",
      path,
      body,
      as: s.human,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await replay.json()).toEqual(await first.json());
    expect(await runCount()).toBe(before + 1); // one run, not two
  });

  it("accepts hr.annual_statement — an 8D code on 7A's unchanged route (spec:2083, 8D T6)", async () => {
    // The definition is read from the SHIPPED file, not restated: a copy here could drift from the seed pack and the
    // test would still pass, which is the thing §4.16.1's one-file-per-code rule prevents.
    const envelope = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "packages/db/seed/my/reports/8d/hr.annual_statement.json"),
        "utf8",
      ),
    ) as { definition: unknown };
    await grantCodes(api.db, s, { codes: ["hr.payroll.read"], roleCode: "annual-8d" });
    await seedReportDefinition(api.db, s, {
      code: "hr.annual_statement",
      definition: envelope.definition,
    });
    await api.loadPrincipals();

    const res = await post(
      { parameters: { taxYear: "2026" }, format: "pdf", lang: "en" },
      s.human,
      "hr.annual_statement",
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string; jobId: string; statusUrl: string };
    expect(body.statusUrl).toContain(body.runId);

    // The run resource exists and is queued. Driving it to `done` is apps/worker's render test's job (§3.1).
    const status = await api.request({ method: "GET", path: body.statusUrl, as: s.human });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { status: string }).status).toBe("queued");

    // Without hr.payroll.read the same POST is refused — the 8D code carries its own gate on 7A's route.
    const outsider = await seedTenantV2(api.db, "runs-api-annual-outsider");
    await grantCodes(api.db, outsider, { codes: EXPORTER });
    await seedReportDefinition(api.db, outsider, {
      code: "hr.annual_statement",
      definition: envelope.definition,
    });
    await api.loadPrincipals();
    const refused = await post(
      { parameters: { taxYear: "2026" }, format: "csv", lang: "en" },
      outsider.human,
      "hr.annual_statement",
      outsider,
    );
    expect(refused.status).toBe(403);
  });
});

describe("the report-run resource — GET …/report-runs, …/{runId}, …/{runId}/content", () => {
  let api: StartedApi;
  let s: Seed;
  const runIds: string[] = [];

  beforeAll(async () => {
    api = await startApi({
      jobs: { enqueue: () => Promise.resolve(crypto.randomUUID()) },
    });
    s = await seedTenantV2(api.db, "run-res");
    await grantCodes(api.db, s, { codes: EXPORTER });
    await seedReportDefinition(api.db, s, {
      code: "accounting.trial_balance",
      definition: { ...DEF, parameters: [], dataset: { source: "account_balance", filters: [] } },
    });
    await api.loadPrincipals();
    for (const format of ["csv", "xlsx", "pdf"] as const) {
      const res = await api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/reports/accounting.trial_balance/runs`,
        body: { parameters: {}, format, lang: "en" },
        as: s.human,
      });
      runIds.push(((await res.json()) as { runId: string }).runId);
    }
  }, 240_000);
  afterAll(async () => {
    await api.stop();
  });

  const get = (path: string, as = s.human) => api.request({ method: "GET", path, as });
  const base = () => `/v1/companies/${s.company}/report-runs`;

  it("lists newest first with a cursor that loses nothing, and accepts the filter[<field>][eq] grammar", async () => {
    const page = (await (await get(`${base()}?limit=2`)).json()) as {
      items: { id: string; format: string }[];
      next_cursor: string | null;
    };
    expect(page.items.map((r) => r.id)).toEqual([runIds[2], runIds[1]]);
    expect(page.next_cursor).not.toBeNull();
    const next = (await (await get(`${base()}?limit=2&cursor=${page.next_cursor}`)).json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(next.items.map((r) => r.id)).toEqual([runIds[0]]);
    expect(next.next_cursor).toBeNull();

    const only = (await (await get(`${base()}?filter[format][eq]=pdf`)).json()) as {
      items: { format: string }[];
    };
    expect(only.items.map((r) => r.format)).toEqual(["pdf"]);

    for (const bad of ["filter[object_key][eq]=x", "filter[format][eq]=docx", "limit=0"])
      expect((await problemOf(await get(`${base()}?${bad}`))).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("404s the content of a run that is not done, and serves the bytes once it is", async () => {
    const runId = runIds[0]!; // the CSV run
    const early = await problemOf(await get(`${base()}/${runId}/content`));
    expect(early.code).toBe("ERR_NOT_FOUND");
    expect(early.detail).toContain("has not finished (status queued)");

    // The worker's completion, simulated: the API side of the contract is what this test covers.
    const bytes = new TextEncoder().encode("Code\r\n1000\r\n");
    const key = reportObjectKeyFor(s.tenant, runId, "csv", 1);
    await api.objectStore.put(key, bytes, "text/csv; charset=utf-8");
    const digest = createHash("sha256").update(bytes).digest();
    await withTenant(
      api.db.rw,
      s.tenant,
      s.system,
      (tx) => tx`update app.report_run set status = 'done', object_key = ${key}, sha256 = ${digest},
                        finished_at = now() where id = ${runId}`,
    );

    const status = (await (await get(`${base()}/${runId}`)).json()) as { sha256: string };
    expect(status.sha256).toBe(digest.toString("hex"));
    const res = await get(`${base()}/${runId}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="accounting.trial_balance-${runId}.csv"`,
    );
    expect(await res.text()).toBe("Code\r\n1000\r\n");

    // Bytes that no longer match the recorded digest are never served.
    await api.objectStore.put(key, new TextEncoder().encode("tampered"), "text/csv; charset=utf-8");
    expect((await problemOf(await get(`${base()}/${runId}/content`))).code).toBe("ERR_INTERNAL");
  });

  it("a failed run's reason reaches the status resource and the content route", async () => {
    const runId = runIds[1]!;
    await withTenant(
      api.db.rw,
      s.tenant,
      s.system,
      (tx) => tx`update app.report_run set status = 'failed', finished_at = now(),
                        error = 'ERR_REPORT_DATASET_UNKNOWN: no dataset' where id = ${runId}`,
    );
    const status = (await (await get(`${base()}/${runId}`)).json()) as {
      status: string;
      error: string;
    };
    expect(status).toMatchObject({
      status: "failed",
      error: "ERR_REPORT_DATASET_UNKNOWN: no dataset",
    });
    const content = await problemOf(await get(`${base()}/${runId}/content`));
    expect(content.code).toBe("ERR_NOT_FOUND");
    expect(content.detail).toContain("ERR_REPORT_DATASET_UNKNOWN");
  });

  it("404s an unknown run id and a run of another company named under this one", async () => {
    expect((await get(`${base()}/${crypto.randomUUID()}`)).status).toBe(404);
    // A second company in the SAME tenant, where the caller also holds export: its path must not reach
    // the first company's run by id (AGENTS.md: an entity id alone).
    const second = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${second}, ${s.tenant}, 'BR2', 'Second', 'MYR')`;
    });
    await grantCodes(api.db, { ...s, company: second }, { codes: EXPORTER });
    const res = await get(`/v1/companies/${second}/report-runs/${runIds[0]}`);
    expect(res.status).toBe(404);
    const list = (await (await get(`/v1/companies/${second}/report-runs`)).json()) as {
      items: unknown[];
    };
    expect(list.items).toEqual([]);
  });

  it("every route needs accounting.report.export — the download IS the export", async () => {
    const readOnly = await seedTenantV2(api.db, "run-res-read");
    await grantCodes(api.db, readOnly, { codes: ["accounting.report.read"] });
    await api.loadPrincipals();
    const path = `/v1/companies/${readOnly.company}/report-runs`;
    for (const p of [
      path,
      `${path}/${crypto.randomUUID()}`,
      `${path}/${crypto.randomUUID()}/content`,
    ])
      expect((await get(p, readOnly.human)).status).toBe(403);
  });

  it("the LIST shows only runs whose definition's own read code the caller holds (7 review)", async () => {
    // Before the fix the list was gated on the export code alone and skipped the per-definition read gate the
    // single-run and content routes apply: an export-only principal listed every run in the company — its
    // parameters, its definition and its requester.
    const exportOnly = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${exportOnly}, 'human', ${`human:list-export-only:${exportOnly}`}, 'list export only')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${exportOnly})`;
    });
    await grantCodes(api.db, s, { codes: ["accounting.report.export"], principalId: exportOnly });
    await api.loadPrincipals();
    const hidden = (await (await get(base(), exportOnly)).json()) as {
      items: { id: string }[];
      next_cursor: string | null;
    };
    expect(hidden.items).toEqual([]);
    expect(hidden.next_cursor).toBeNull();
    // The holder of the definition's `accounting.report.read` still sees every one of them.
    const shown = (await (await get(base())).json()) as { items: { id: string }[] };
    expect(shown.items.map((r) => r.id)).toEqual(expect.arrayContaining(runIds));
  });

  it("re-evaluates the definition's own read code on every read of a run", async () => {
    // The export code alone, without the definition's `accounting.report.read`, opens nothing.
    const exportOnly = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${exportOnly}, 'human', ${`human:export-only:${exportOnly}`}, 'export only')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${exportOnly})`;
    });
    await grantCodes(api.db, s, { codes: ["accounting.report.export"], principalId: exportOnly });
    await api.loadPrincipals();
    const problem = await problemOf(await get(`${base()}/${runIds[2]}`, exportOnly));
    expect(problem.status).toBe(403);
    expect(problem.detail).toContain("accounting.report.read");
  });
});
