import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_TABLES, NEVER_EXPORTED } from "../../src/export/tables";
import {
  claimImportRun,
  completeImportRun,
  createImportRun,
  failImportRun,
  getImportRun,
  IMPORT_RUN_HEARTBEAT_SECONDS,
  IMPORT_RUN_JOB_OPTIONS,
  IMPORT_RUN_LEASE_SECONDS,
  IMPORT_RUN_MAX_CLAIMS,
  importRunLeaseState,
  listImportRuns,
  liveImportRun,
  renewImportRunLease,
} from "../../src/import/run";
import { AUDIT_EXEMPT, IMMUTABLE, lintSchema } from "../../src/lint-schema";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

let db: Db;
let a: Seed;
let b: Seed;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenantV2(db, "import-run-a");
  b = await seedTenantV2(db, "import-run-b");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

const MAP = { generatedFrom: "test", entries: [] };
const create = (s: Seed, over: Partial<Parameters<typeof createImportRun>[1]> = {}) =>
  withTenant(db.rw, s.tenant, s.human, (tx) =>
    createImportRun(tx, {
      companyId: s.company,
      cutOverDate: "2026-01-31",
      dryRun: true,
      ...over,
    }),
  );
/** Settles every live run of the seed's company, so each case starts with the company free (one live run each). */
const settle = (s: Seed) =>
  withTenant(
    db.rw,
    s.tenant,
    s.system,
    (
      tx,
    ) => tx`update app.import_run set status = 'failed', error = 'ERR_INTERNAL: test', finished_at = now()
                where company_id = ${s.company} and status in ('queued', 'running')`,
  );

describe("migration 0103 — app.import_run (9B Task 9, contracts round 20 C17)", () => {
  it("joins no linter set and the schema linter reports nothing (§3.5.2, §3.5.3)", async () => {
    expect(AUDIT_EXEMPT.has("import_run")).toBe(false);
    expect(IMMUTABLE.has("import_run")).toBe(false);
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("is pinned whole in NEVER_EXPORTED, as export_job is (plumbing, ADR 0069)", () => {
    expect(NEVER_EXPORTED["import_run"]).toEqual(["*"]);
    expect(Object.keys(EXPORT_TABLES)).not.toContain("import_run");
  });

  it("stores the request and stamps requested_by from the actor, never from the caller", async () => {
    const run = await create(a, { only: ["unit_of_measure"], accountMap: MAP });
    expect(run).toMatchObject({
      companyId: a.company,
      requestedBy: a.human,
      cutOverDate: "2026-01-31",
      dryRun: true,
      only: ["unit_of_measure"],
      accountMap: MAP,
      status: "queued",
      perLoader: null,
      skipCount: null,
      attempts: 0,
      error: null,
    });
    await settle(a);
    const id = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx`insert into app.import_run (id, tenant_id, company_id, requested_by, cut_over_date)
                 values (${id}, ${a.tenant}, ${a.company}, ${a.system}, '2026-01-31')`,
    );
    const [row] = await db.admin<{ requested_by: string }[]>`
      select requested_by from app.import_run where id = ${id}`;
    expect(row!.requested_by).toBe(a.human);
    await settle(a);
  });

  it("admits ONE queued or running run per company — a finished one frees the slot the same day", async () => {
    const first = await create(a);
    expect(
      (await withTenant(db.rw, a.tenant, a.human, (tx) => liveImportRun(tx, a.company)))?.id,
    ).toBe(first.id);
    await expect(create(a)).rejects.toThrow(/import_run_one_live_per_company/);
    // Another company of another tenant is unaffected.
    const other = await create(b);
    expect(other.status).toBe("queued");
    await withTenant(db.rw, a.tenant, a.system, (tx) =>
      failImportRun(tx, { id: first.id, error: "ERR_VALIDATION_FAILED: test" }),
    );
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) => liveImportRun(tx, a.company)),
    ).toBeNull();
    const second = await create(a);
    expect(second.status).toBe("queued");
    await settle(a);
    await settle(b);
  });

  it("refuses an outcome the CHECKs do not admit", async () => {
    const insert = (status: string, extra: { error?: string; perLoader?: string } = {}) =>
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (
          tx,
        ) => tx`insert into app.import_run (tenant_id, company_id, cut_over_date, status, error, per_loader,
                                                skip_count, finished_at)
                   values (${a.tenant}, ${a.company}, '2026-01-31', ${status}, ${extra.error ?? null},
                           ${extra.perLoader ?? null}::jsonb, ${extra.perLoader ? 0 : null},
                           ${status === "queued" || status === "running" ? null : new Date()})`,
      );
    await expect(insert("paused")).rejects.toThrow(/import_run_status_check/);
    await expect(insert("done")).rejects.toThrow(/import_run_outcome_is_exclusive/);
    await expect(insert("failed")).rejects.toThrow(/import_run_outcome_is_exclusive/);
    await expect(insert("failed", { error: "ERR_X: y", perLoader: "{}" })).rejects.toThrow(
      /import_run_outcome_is_exclusive/,
    );
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`insert into app.import_run (tenant_id, company_id, cut_over_date, only_targets)
                   values (${a.tenant}, ${a.company}, '2026-01-31', '{}'::text[])`,
      ),
    ).rejects.toThrow(/import_run_only_targets_check/);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`insert into app.import_run (tenant_id, company_id, cut_over_date, account_map)
                   values (${a.tenant}, ${a.company}, '2026-01-31', '[]'::jsonb)`,
      ),
    ).rejects.toThrow(/import_run_account_map_check/);
  });

  it("a second tenant cannot see, list, claim or fail it (§3.3, test 12)", async () => {
    const run = await create(a);
    await withTenant(db.rw, b.tenant, b.system, async (tx) => {
      expect(await getImportRun(tx, run.id)).toBeNull();
      expect(await listImportRuns(tx, { companyId: a.company, limit: 50 })).toEqual([]);
      expect(await claimImportRun(tx, run.id)).toBeNull();
      expect(await importRunLeaseState(tx, run.id)).toBeNull();
      expect(await failImportRun(tx, { id: run.id, error: "ERR_X: y" })).toBe(false);
    });
    // And a company of another tenant is refused by the composite FK, whatever the caller names.
    await expect(
      withTenant(
        db.rw,
        b.tenant,
        b.human,
        (tx) => tx`insert into app.import_run (tenant_id, company_id, cut_over_date)
                   values (${b.tenant}, ${a.company}, '2026-01-31')`,
      ),
    ).rejects.toThrow();
    expect(
      (await withTenant(db.rw, a.tenant, a.human, (tx) => getImportRun(tx, run.id)))?.status,
    ).toBe("queued");
    await settle(a);
  });

  it("claims under a lease, fences a superseded worker and records the outcome", async () => {
    const run = await create(a, { dryRun: false });
    const claimed = await withTenant(db.rw, a.tenant, a.system, (tx) => claimImportRun(tx, run.id));
    expect(claimed).toMatchObject({ status: "running", attempts: 1 });
    expect(claimed!.startedAt).not.toBeNull();
    // A live claim is not taken again.
    expect(
      await withTenant(db.rw, a.tenant, a.system, (tx) => claimImportRun(tx, run.id)),
    ).toBeNull();
    const state = await withTenant(db.rw, a.tenant, a.system, (tx) =>
      importRunLeaseState(tx, run.id),
    );
    expect(state!.status).toBe("running");
    expect(state!.remainingSeconds).toBeGreaterThan(IMPORT_RUN_LEASE_SECONDS - 60);
    // A stale claim number writes nothing.
    expect(
      await withTenant(db.rw, a.tenant, a.system, (tx) =>
        completeImportRun(tx, {
          id: run.id,
          perLoader: {},
          skipCount: 0,
          artefactCount: 0,
          attempt: 9,
        }),
      ),
    ).toBe(false);
    const perLoader = { unit_of_measure: { inserted: 2, skipped: 0, conflicts: 0 } };
    expect(
      await withTenant(db.rw, a.tenant, a.system, (tx) =>
        completeImportRun(tx, {
          id: run.id,
          perLoader,
          skipCount: 1,
          artefactCount: 4,
          attempt: 1,
        }),
      ),
    ).toBe(true);
    const done = await withTenant(db.rw, a.tenant, a.human, (tx) => getImportRun(tx, run.id));
    expect(done).toMatchObject({
      status: "done",
      perLoader,
      skipCount: 1,
      artefactCount: 4,
      error: null,
    });
    expect(done!.finishedAt).not.toBeNull();
    // A finished run is never claimed again (a redelivery is a no-op) and never failed after the fact.
    expect(
      await withTenant(db.rw, a.tenant, a.system, (tx) => claimImportRun(tx, run.id)),
    ).toBeNull();
    expect(
      await withTenant(db.rw, a.tenant, a.system, (tx) =>
        failImportRun(tx, { id: run.id, error: "ERR_X: late" }),
      ),
    ).toBe(false);
    // Every status move is audited under the actor that made it (test 13).
    const audit = await db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log where table_name = 'import_run' and row_id = ${run.id} order by seq`;
    expect(audit.map((r) => r.action)).toEqual(["insert", "update", "update"]);
    expect(audit[0]!.actor_id).toBe(a.human);
    expect(audit[2]!.actor_id).toBe(a.system);
  });

  it("reclaims a run whose worker died and fails it on the claim after the maximum", async () => {
    const run = await create(a, { dryRun: false });
    const age = () =>
      withTenant(
        db.rw,
        a.tenant,
        a.system,
        (tx) => tx`update app.import_run
                      set started_at = now() - make_interval(secs => ${IMPORT_RUN_LEASE_SECONDS + 5})
                    where id = ${run.id}`,
      );
    for (let claim = 1; claim <= IMPORT_RUN_MAX_CLAIMS; claim += 1) {
      const got = await withTenant(db.rw, a.tenant, a.system, (tx) => claimImportRun(tx, run.id));
      expect(got).toMatchObject({ status: "running", attempts: claim });
      await age();
    }
    const last = await withTenant(db.rw, a.tenant, a.system, (tx) => claimImportRun(tx, run.id));
    expect(last).toMatchObject({ status: "failed", attempts: IMPORT_RUN_MAX_CLAIMS + 1 });
    expect(last!.error).toMatch(/^ERR_INTERNAL: the import run was claimed 2 times/);
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) => liveImportRun(tx, a.company)),
    ).toBeNull();
  });

  it("renews a live claim on its heartbeat, throttled, so a redelivery after the lease finds it live; a superseded claim learns so (9B review, finding 5)", async () => {
    await settle(a);
    const run = await create(a, { dryRun: false });
    const as = <T>(fn: (tx: Sql) => Promise<T>) => withTenant(db.rw, a.tenant, a.system, fn);
    const age = (seconds: number) =>
      as(
        (tx) => tx`update app.import_run set started_at = now() - make_interval(secs => ${seconds})
                    where id = ${run.id}`,
      );
    expect(await as((tx) => claimImportRun(tx, run.id))).toMatchObject({ attempts: 1 });
    // Just claimed: nothing to renew, and no audited write.
    expect(await as((tx) => renewImportRunLease(tx, run.id, 1))).toBe("fresh");
    await age(IMPORT_RUN_HEARTBEAT_SECONDS + 5);
    expect(await as((tx) => renewImportRunLease(tx, run.id, 1))).toBe("renewed");
    // Four hours after the CLAIM but minutes after the heartbeat: a redelivery cannot take it over.
    expect(await as((tx) => claimImportRun(tx, run.id))).toBeNull();
    expect((await as((tx) => importRunLeaseState(tx, run.id)))!.remainingSeconds).toBeGreaterThan(
      IMPORT_RUN_LEASE_SECONDS - 60,
    );
    // A claim that DID lapse is reclaimed; the first worker's next heartbeat is told it is superseded.
    await age(IMPORT_RUN_LEASE_SECONDS + 5);
    expect(await as((tx) => claimImportRun(tx, run.id))).toMatchObject({ attempts: 2 });
    expect(await as((tx) => renewImportRunLease(tx, run.id, 1))).toBe("superseded");
    expect(await as((tx) => renewImportRunLease(tx, run.id, 2))).toBe("fresh");
    await settle(a);
    expect(await as((tx) => renewImportRunLease(tx, run.id, 2))).toBe("superseded");
  });

  it("caps a failure reason and lists newest first, by company", async () => {
    const run = await create(a);
    await withTenant(db.rw, a.tenant, a.system, (tx) =>
      failImportRun(tx, { id: run.id, error: `ERR_VALIDATION_FAILED: ${"x".repeat(5000)}` }),
    );
    const failed = await withTenant(db.rw, a.tenant, a.human, (tx) => getImportRun(tx, run.id));
    expect(failed!.error!.length).toBe(2000);
    const listed = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listImportRuns(tx, { companyId: a.company, limit: 2 }),
    );
    expect(listed[0]!.id).toBe(run.id);
    expect(listed).toHaveLength(2);
    const failedOnly = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listImportRuns(tx, { companyId: a.company, status: "done", limit: 50 }),
    );
    expect(failedOnly.every((r) => r.status === "done")).toBe(true);
    const page2 = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listImportRuns(tx, {
        companyId: a.company,
        limit: 50,
        cursor: { createdAt: listed[1]!.createdAt, id: listed[1]!.id },
      }),
    );
    expect(page2.map((r) => r.id)).not.toContain(listed[0]!.id);
    expect(page2.map((r) => r.id)).not.toContain(listed[1]!.id);
  });

  it("enqueues with the lease's options: retries past the claims, expiry at the lease", () => {
    expect(IMPORT_RUN_JOB_OPTIONS).toEqual({
      retryLimit: IMPORT_RUN_MAX_CLAIMS + 2,
      retryDelaySeconds: 60,
      expireInSeconds: IMPORT_RUN_LEASE_SECONDS,
    });
  });

  it("app_rw holds no DELETE on it (§3.5.4)", async () => {
    const rows = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'import_run'
       order by privilege_type`;
    expect(rows.map((r) => r.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});
