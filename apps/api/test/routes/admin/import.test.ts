import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createJobClient,
  failImportRun,
  claimImportRun,
  IMPORT_RUN_JOB_OPTIONS,
  IMPORT_RUN_LEASE_SECONDS,
  importWriteCodes,
  JOB_NAMES,
  type JobClient,
} from "@dulja/db";
import {
  grantCodes,
  installBoss,
  seedImportBatch,
  seedTenantV2,
  stopBoss,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

/**
 * 9B Task 9 — the cut-over load's bulk endpoint and spec:2206's status resource (contracts §4.2.7 as amended by round
 * 20's C2, C4 and C17). A REAL pg-boss sits behind the API's job client (startApi's stub refuses `admin.import.run`),
 * so the test reads the job the POST enqueued on its own transaction from pg-boss's own row: `pgboss.job` carries no
 * RLS (§4.2.6), so `db.admin` reads it directly, and the envelope's `tenantId` is what `/v1/jobs` scopes on.
 */
const MAP = {
  generatedFrom: "synthetic",
  entries: [
    {
      legacyCode: "1101",
      code: "1000",
      nameEn: "Cash on hand",
      nameAr: null,
      type: "asset",
      treatment: "balance",
      note: null,
    },
  ],
};

const importsPath = (companyId: string) => `/v1/companies/${companyId}/imports`;
const LOADER_GRANT = ["admin.company.manage", ...importWriteCodes(null)];

function bossBackedJobs() {
  const state: { real: JobClient | null } = { real: null };
  const jobs: JobClient = {
    enqueue: (tx, name, job, options) => {
      if (!state.real) throw new Error("pg-boss is not installed yet");
      return state.real.enqueue(tx, name, job, options);
    },
  };
  return { state, jobs };
}

describe("the import routes and /v1/jobs/{jobId} (9B Task 9)", () => {
  let api: StartedApi;
  let boss: Awaited<ReturnType<typeof installBoss>> | undefined;
  const { state, jobs } = bossBackedJobs();
  let s: Seed;
  let other: Seed;
  let bare: Seed;
  /** A second holder of admin.company.manage in `s`'s company, and a branch-narrowed one. */
  let colleague: string;
  let narrowed: string;
  /** admin.company.manage with inventory.item.manage and nothing else: may load master data, never post an opening. */
  let clerk: string;

  beforeAll(async () => {
    api = await startApi({ jobs });
    boss = await installBoss(api.db, JOB_NAMES);
    state.real = createJobClient(boss);
    s = await seedTenantV2(api.db, "import-routes");
    other = await seedTenantV2(api.db, "import-routes-b");
    bare = await seedTenantV2(api.db, "import-routes-bare"); // granted nothing
    // The route's gate AND every code of every loader a default run executes (9B review, finding 4).
    await grantCodes(api.db, s, { codes: LOADER_GRANT });
    await grantCodes(api.db, other, { codes: LOADER_GRANT });
    colleague = await uuidv7(api.db.admin);
    narrowed = await uuidv7(api.db.admin);
    clerk = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      for (const [id, label] of [
        [colleague, "colleague"],
        [narrowed, "narrowed"],
        [clerk, "clerk"],
      ] as const) {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`human:${label}:${s.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
      }
    });
    await grantCodes(api.db, s, { codes: LOADER_GRANT, principalId: colleague });
    await grantCodes(api.db, s, {
      codes: ["admin.company.manage", "inventory.item.manage"],
      principalId: clerk,
    });
    await grantCodes(api.db, s, {
      codes: ["admin.company.manage"],
      principalId: narrowed,
      branchIds: [s.hq],
    });
    await api.loadPrincipals();
  }, 300_000);
  afterAll(async () => {
    if (boss) await stopBoss(boss);
    await api?.stop();
  });

  const post = (body: unknown, as: string, companyId: string, idempotencyKey?: null) =>
    api.request({
      method: "POST",
      path: importsPath(companyId),
      body,
      as,
      ...(idempotencyKey === null ? { idempotencyKey: null } : {}),
    });
  /** Settles the company's live run, as the job would: one live run per company (migration 0103). */
  const settle = async (seed: Seed, runId: string) => {
    await withTenant(api.db.rw, seed.tenant, seed.system, (tx) =>
      failImportRun(tx, { id: runId, error: "ERR_VALIDATION_FAILED: settled by the test" }),
    );
  };
  const start = async (seed = s, as = s.human, body: Record<string, unknown> = {}) => {
    const res = await post({ cutOverDate: "2026-01-31", dryRun: true, ...body }, as, seed.company);
    expect(res.status).toBe(202);
    return (await res.json()) as { runId: string; jobId: string; statusUrl: string };
  };

  describe("POST /v1/companies/{companyId}/imports (spec:2206, async job semantics)", () => {
    it("records the run and enqueues admin.import.run in one transaction, answering 202 with /v1/jobs/{jobId}", async () => {
      const body = await start(s, s.human, {
        accountMap: MAP,
        only: ["unit_of_measure", "account"],
      });
      expect(body.statusUrl).toBe(`/v1/jobs/${body.jobId}`);
      const [job] = await api.db.admin<
        {
          name: string;
          data: { tenantId: string; payload: Record<string, unknown> };
          singleton_key: string | null;
          retry_limit: number;
          expire_seconds: number;
        }[]
      >`select name, data, singleton_key, retry_limit, expire_seconds from pgboss.job where id = ${body.jobId}::uuid`;
      expect(job!.name).toBe("admin.import.run");
      expect(job!.data.tenantId).toBe(s.tenant);
      // C3's payload exactly — never the account map, which lives on the RLS-bound run row.
      expect(job!.data.payload).toEqual({
        companyId: s.company,
        runId: body.runId,
        cutOverDate: "2026-01-31",
        dryRun: true,
        only: ["unit_of_measure", "account"],
      });
      // No pg-boss singleton: the one-live-run rule is the data layer's (0103). The lease's options instead.
      expect(job!.singleton_key).toBeNull();
      expect(job!.retry_limit).toBe(IMPORT_RUN_JOB_OPTIONS.retryLimit);
      expect(job!.expire_seconds).toBe(IMPORT_RUN_JOB_OPTIONS.expireInSeconds);
      const [run] = await api.db.admin<
        { requested_by: string; status: string; account_map: unknown; only_targets: string[] }[]
      >`select requested_by, status, account_map, only_targets from app.import_run where id = ${body.runId}`;
      expect(run).toEqual({
        requested_by: s.human,
        status: "queued",
        account_map: MAP,
        only_targets: ["unit_of_measure", "account"],
      });
      await settle(s, body.runId);
    });

    it("refuses a second live run of the company with 409, naming the run in the way; a finished one frees it", async () => {
      const first = await start();
      const res = await post({ cutOverDate: "2026-01-31", dryRun: false }, s.human, s.company);
      expect(res.status).toBe(409);
      const problem = await problemOf(res);
      expect(problem.code).toBe("ERR_CONFLICT_UNIQUE");
      expect(problem.detail).toContain(first.runId);
      await settle(s, first.runId);
      const second = await start(s, s.human, { dryRun: false });
      expect(second.runId).not.toBe(first.runId);
      await settle(s, second.runId);
    });

    it("supersedes a run that stayed queued past the lease with no claim — its job was lost — so the company is never blocked for ever (9B review, finding 7)", async () => {
      const stale = await start();
      const age = (runId: string) =>
        withTenant(
          api.db.rw,
          s.tenant,
          s.system,
          (tx) => tx`update app.import_run
                        set created_at = now() - make_interval(secs => ${IMPORT_RUN_LEASE_SECONDS + 60})
                      where id = ${runId}`,
        );
      await age(stale.runId);
      const next = await start();
      expect(next.runId).not.toBe(stale.runId);
      const [old] = await api.db.admin<
        { status: string; error: string; finished_at: Date | null }[]
      >`
        select status, error, finished_at from app.import_run where id = ${stale.runId}`;
      expect(old!.status).toBe("failed");
      expect(old!.error).toMatch(
        /^ERR_INTERNAL: the import run stayed queued for more than 4 hours and no worker ever claimed it/,
      );
      // A CLAIMED run is the lease's to settle, however old: it still holds the slot.
      await settle(s, next.runId);
      const claimed = await start();
      await withTenant(api.db.rw, s.tenant, s.system, (tx) => claimImportRun(tx, claimed.runId));
      await age(claimed.runId);
      const refused = await post({ cutOverDate: "2026-01-31", dryRun: true }, s.human, s.company);
      expect(refused.status).toBe(409);
      await settle(s, claimed.runId);
    });

    it("refuses a caller of another tenant against this company (test 12) and enqueues nothing", async () => {
      const before = await api.db.admin<{ n: number }[]>`
        select count(*)::int as n from pgboss.job where name = 'admin.import.run'`;
      const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, other.human, s.company);
      expect(res.status).toBe(403);
      expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
      const after = await api.db.admin<{ n: number }[]>`
        select count(*)::int as n from pgboss.job where name = 'admin.import.run'`;
      expect(after[0]!.n).toBe(before[0]!.n);
    });

    it("refuses a caller without admin.company.manage, and a branch-narrowed holder (test 36)", async () => {
      const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, bare.human, bare.company);
      expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
      const narrow = await post({ cutOverDate: "2026-01-31", dryRun: true }, narrowed, s.company);
      expect((await problemOf(narrow)).code).toBe("ERR_RBAC_FORBIDDEN");
    });

    it("refuses a requester who lacks a write code of a loader the run executes, naming each, and enqueues nothing (9B review, finding 4)", async () => {
      const count = async () =>
        (
          await api.db.admin<{ n: number }[]>`
            select ((select count(*) from pgboss.job where name = 'admin.import.run')
                  + (select count(*) from app.import_run where company_id = ${s.company}))::int as n`
        )[0]!.n;
      const before = await count();
      // A default run executes every loader: the openings post under accounting.journal.post and
      // inventory.receipt.post, the employee master writes sealed fields — admin.company.manage alone clears none.
      const all = await post({ cutOverDate: "2026-01-31", dryRun: true }, clerk, s.company);
      expect(all.status).toBe(403);
      const problem = await problemOf(all);
      expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
      for (const code of [
        "accounting.journal.post",
        "inventory.receipt.post",
        "hr.employee.read_sensitive",
        "hr.payroll.post",
      ])
        expect(problem.detail).toContain(code);
      expect(problem.detail).not.toContain("inventory.item.manage");
      // `only` is respected: the opening alone needs accounting.journal.post, which the clerk lacks …
      const opening = await post(
        { cutOverDate: "2026-01-31", dryRun: true, only: ["opening_balance"], accountMap: MAP },
        clerk,
        s.company,
      );
      expect(opening.status).toBe(403);
      expect((await problemOf(opening)).detail).toContain("accounting.journal.post");
      expect(await count()).toBe(before);
      // … and the units alone need only inventory.item.manage, which the clerk holds.
      const units = await post(
        { cutOverDate: "2026-01-31", dryRun: true, only: ["unit_of_measure"] },
        clerk,
        s.company,
      );
      expect(units.status).toBe(202);
      await settle(s, ((await units.json()) as { runId: string }).runId);
    });

    it("refuses a cut-over date that is not a date, an unknown field, an empty only and a malformed map", async () => {
      for (const body of [
        { cutOverDate: "31/01/2026", dryRun: false },
        { cutOverDate: "2026-02-30", dryRun: false },
        { cutOverDate: "2026-01-31", dryRun: false, source: "odbc" },
        { cutOverDate: "2026-01-31", only: [] },
        { cutOverDate: "2026-01-31", only: ["Item"] },
        { cutOverDate: "2026-01-31", accountMap: { generatedFrom: "x", entries: [] } },
        {
          cutOverDate: "2026-01-31",
          accountMap: { ...MAP, entries: [{ ...MAP.entries[0], code: "10000" }] },
        },
      ]) {
        const res = await post(body, s.human, s.company);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
      }
      expect(
        (
          await api.db.admin<{ n: number }[]>`
            select count(*)::int as n from app.import_run where company_id = ${s.company} and status = 'queued'`
        )[0]!.n,
      ).toBe(0);
    });

    it("requires the Idempotency-Key header, like every unsafe route (spec:2055)", async () => {
      const res = await post({ cutOverDate: "2026-01-31", dryRun: true }, s.human, s.company, null);
      expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
    });
  });

  describe("GET …/imports and …/imports/{runId}", () => {
    it("reports the run and the rows it committed per target table", async () => {
      const { runId } = await start(s, s.human, { accountMap: MAP });
      const target = await uuidv7(api.db.admin);
      await seedImportBatch(api.db, s, {
        sourceTable: "UNITS",
        sourceKey: `route-${runId}`,
        targetTable: "unit_of_measure",
        targetId: target,
        runId,
      });
      const res = await api.request({
        method: "GET",
        path: `${importsPath(s.company)}/${runId}`,
        as: s.human,
      });
      expect(res.status).toBe(200);
      const run = (await res.json()) as Record<string, unknown>;
      expect(run).toMatchObject({
        runId,
        companyId: s.company,
        requestedBy: s.human,
        cutOverDate: "2026-01-31",
        dryRun: true,
        only: null,
        hasAccountMap: true,
        status: "queued",
        perTargetTable: [{ targetTable: "unit_of_measure", rows: 1 }],
        perLoader: null,
        skips: null,
        error: null,
        startedAt: null,
      });
      expect(run).not.toHaveProperty("accountMap");
      // A colleague holding the same code company-wide reads it (7A's report-run rule, not 7C's requester rule):
      // a run's record carries counts and codes, nothing another code gates.
      const seen = await api.request({
        method: "GET",
        path: `${importsPath(s.company)}/${runId}`,
        as: colleague,
      });
      expect(seen.status).toBe(200);
      const listed = await api.request({
        method: "GET",
        path: importsPath(s.company),
        as: s.human,
      });
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as {
        items: { runId: string }[];
        next_cursor: string | null;
      };
      expect(page.items[0]!.runId).toBe(runId);
      await settle(s, runId);
    });

    it("pages the list newest first and filters by status", async () => {
      const a1 = await start();
      await settle(s, a1.runId);
      const a2 = await start();
      await settle(s, a2.runId);
      const first = await api.request({
        method: "GET",
        path: `${importsPath(s.company)}?limit=1&filter[status][eq]=failed`,
        as: s.human,
      });
      const page1 = (await first.json()) as {
        items: { runId: string; status: string }[];
        next_cursor: string | null;
      };
      expect(page1.items.map((r) => r.runId)).toEqual([a2.runId]);
      expect(page1.next_cursor).not.toBeNull();
      const second = await api.request({
        method: "GET",
        path: `${importsPath(s.company)}?limit=1&filter[status][eq]=failed&cursor=${page1.next_cursor}`,
        as: s.human,
      });
      const page2 = (await second.json()) as { items: { runId: string }[] };
      expect(page2.items.map((r) => r.runId)).toEqual([a1.runId]);
    });

    it("404s on a run of another company or tenant, and 403s a caller outside the company", async () => {
      const theirs = await start(other, other.human);
      const res = await api.request({
        method: "GET",
        path: `${importsPath(s.company)}/${theirs.runId}`,
        as: s.human,
      });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
      const outside = await api.request({
        method: "GET",
        path: `${importsPath(other.company)}/${theirs.runId}`,
        as: s.human,
      });
      expect(outside.status).toBe(403);
      await settle(other, theirs.runId);
    });
  });

  describe("GET /v1/jobs/{jobId} — the status resource §4.2.7 promised and no slice had built (C2)", () => {
    it("returns the job's state and its subject to the requester", async () => {
      const { jobId, runId } = await start();
      const res = await api.request({ method: "GET", path: `/v1/jobs/${jobId}`, as: s.human });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        jobId,
        name: "admin.import.run",
        state: "created",
        completedOn: null,
        output: {
          resourceUrl: `/v1/companies/${s.company}/imports/${runId}`,
          status: "queued",
          error: null,
        },
      });
      expect(String(body["createdOn"])).toMatch(/Z$/);
      // The subject's failure is what the job status shows, never pg-boss's raw output (a stack trace).
      await settle(s, runId);
      const failed = (await (
        await api.request({ method: "GET", path: `/v1/jobs/${jobId}`, as: s.human })
      ).json()) as { output: { status: string; error: string } };
      expect(failed.output).toMatchObject({
        status: "failed",
        error: "ERR_VALIDATION_FAILED: settled by the test",
      });
    });

    it("404s on another tenant's job and never reveals that it exists (test 12)", async () => {
      const { jobId, runId } = await start(other, other.human);
      const res = await api.request({ method: "GET", path: `/v1/jobs/${jobId}`, as: s.human });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
      await settle(other, runId);
    });

    it("404s on another requester's job of the same company, and on an unknown id alike", async () => {
      const { jobId, runId } = await start();
      const colleagues = await api.request({
        method: "GET",
        path: `/v1/jobs/${jobId}`,
        as: colleague,
      });
      expect(colleagues.status).toBe(404);
      const unknown = await api.request({
        method: "GET",
        path: `/v1/jobs/${await uuidv7(api.db.admin)}`,
        as: s.human,
      });
      expect(unknown.status).toBe(404);
      // The same refusal, word for word but the id, so a 404 never says "it exists, but not for you".
      const [theirs, none] = [await problemOf(colleagues), await problemOf(unknown)];
      expect(theirs.code).toBe("ERR_NOT_FOUND");
      expect(theirs.detail.replace(jobId, "<id>")).toBe(
        none.detail.replace(/[0-9a-f-]{36}/, "<id>"),
      );
      expect(theirs.detail).not.toContain(s.company);
      await settle(s, runId);
    });

    it("404s once the requester no longer holds admin.company.manage in the run's company", async () => {
      const { jobId, runId } = await start(s, colleague);
      await withTenant(
        api.db.migrator,
        s.tenant,
        s.system,
        (tx) =>
          tx`update app.role_assignment set expires_at = now() - interval '1 minute'
              where principal_id = ${colleague}`,
      );
      const res = await api.request({ method: "GET", path: `/v1/jobs/${jobId}`, as: colleague });
      expect(res.status).toBe(404);
      await settle(s, runId);
    });

    it("404s on a job that has a resource of its own (an export, a report run) or none (a scheduled job)", async () => {
      const jobId = await uuidv7(api.db.admin);
      await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
        state.real!.enqueue(tx, "admin.export.run", {
          tenantId: s.tenant,
          requestId: jobId,
          payload: { exportJobId: jobId },
        }),
      ).then(async (id) => {
        const res = await api.request({ method: "GET", path: `/v1/jobs/${id}`, as: s.human });
        expect(res.status).toBe(404);
      });
    });

    it("refuses an id that is not a uuid as a validation failure", async () => {
      const res = await api.request({ method: "GET", path: "/v1/jobs/not-a-job", as: s.human });
      expect(res.status).toBe(400);
    });
  });
});
