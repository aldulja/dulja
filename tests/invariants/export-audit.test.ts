import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryObjectStore, systemContext, verifyChain, withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { exportRun } from "../../apps/worker/src/jobs/export-run";
import { setObjectStore } from "../../apps/worker/src/object-store";
import { problemOf } from "../support/api";

/**
 * Part VI test 13's export clause (spec:2430): "every write produces an audit record with a server-supplied
 * actor; no flag suppresses it" — applied to the tenant data export (7C Task 10). The request is audited under
 * the requester, the job's claim and completion under the tenant's system principal (hazard 20), the rows are
 * immutable to `app_rw`, and the chain still verifies afterwards.
 */
describe("Part VI test 13 — every export is audited, and no flag suppresses it", () => {
  let api: StartedApi;
  let s: Seed;
  let requester: string;

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "export-audit");
    requester = s.human;
    await grantCodes(api.db, s, {
      codes: ["admin.data.export", "accounting.ledger.read"],
      principalId: requester,
      roleCode: "exp-audit",
    });
    await api.loadPrincipals();
    setObjectStore(new MemoryObjectStore());
  }, 300_000);
  afterAll(async () => {
    await api.stop();
  });

  const request = async (body: unknown): Promise<string> => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/exports`,
      body,
      as: requester,
    });
    expect(res.status).toBe(202);
    return ((await res.json()) as { exportJobId: string }).exportJobId;
  };
  const trail = (exportJobId: string) =>
    api.db.admin<{ action: string; actor_id: string }[]>`
      select action, actor_id from app.audit_log
       where table_name = 'export_job' and row_id = ${exportJobId} order by seq`;
  /** The worker's own handler, run as the worker runs it: under the tenant's system principal. */
  const runJobFor = async (exportJobId: string) => {
    const requestId = await uuidv7(api.db.admin);
    await exportRun(
      api.db.rw,
      { tenantId: s.tenant, requestId, payload: { exportJobId } },
      await systemContext(api.db.rw, s.tenant, requestId),
    );
  };

  it("the request writes one audit row naming the REQUESTER, not the server", async () => {
    const exportJobId = await request({ format: "both" });
    const rows = await trail(exportJobId);
    expect(rows).toEqual([{ action: "insert", actor_id: requester }]);
  });

  it("every format and attachment choice is audited alike, and the body has no field that could opt out", async () => {
    for (const body of [
      { format: "csv", includeAttachments: false },
      { format: "json", includeAttachments: true },
    ]) {
      const exportJobId = await request(body);
      expect(await trail(exportJobId), JSON.stringify(body)).toHaveLength(1);
    }
    const refused = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/exports`,
      body: { format: "both", audit: false },
      as: requester,
    });
    expect(refused.status).toBe(400);
    expect((await problemOf(refused)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the job's claim and completion are audited under the tenant's SYSTEM principal (hazard 20)", async () => {
    const exportJobId = await request({ format: "both" });
    await runJobFor(exportJobId);
    const rows = await trail(exportJobId);
    expect(rows.map((r) => r.action)).toEqual(["insert", "update", "update"]); // request, claim, complete
    expect(rows.map((r) => r.actor_id)).toEqual([requester, s.system, s.system]);
    const [row] = await api.db.admin<{ status: string; requested_by: string }[]>`
      select status, requested_by from app.export_job where id = ${exportJobId}`;
    expect(row).toEqual({ status: "done", requested_by: requester });
  });

  it("the audit rows cannot be updated or deleted by app_rw", async () => {
    const exportJobId = await request({ format: "csv" });
    const ctx = { tenantId: s.tenant, actorId: requester, requestId: await uuidv7(api.db.admin) };
    await expect(
      withTenant(
        api.db.rw,
        ctx,
        (tx) => tx`delete from app.audit_log where row_id = ${exportJobId}`,
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(
        api.db.rw,
        ctx,
        (tx) => tx`update app.audit_log set actor_id = ${s.system} where row_id = ${exportJobId}`,
      ),
    ).rejects.toThrow();
    expect(await trail(exportJobId)).toEqual([{ action: "insert", actor_id: requester }]);
  });

  it("the tenant's audit chain still verifies after exports have been requested and run", async () => {
    await runJobFor(await request({ format: "json" }));
    const result = await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(api.db.admin) },
      (tx) => verifyChain(tx, s.tenant),
    );
    expect(result.rows).toBeGreaterThan(0);
    expect(result).toMatchObject({ brokenLinks: 0, badHashes: 0 });
  });
});
