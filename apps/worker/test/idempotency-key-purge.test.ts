import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedTenant, uuidv7, type Seed } from "@dulja/db/test";
import { startWorker, type StartedWorker } from "./support/worker";

describe("admin.idempotency_key.purge", () => {
  let worker: StartedWorker;
  let alpha: Seed;
  let beta: Seed;
  beforeAll(async () => {
    worker = await startWorker();
    alpha = await seedTenant(worker.db, "Alpha");
    beta = await seedTenant(worker.db, "Beta");
  });
  afterAll(async () => {
    await worker.stop();
  });
  beforeEach(() => {
    worker.logs.length = 0;
  });
  const insertKey = async (seed: Seed, key: string, expiresAt: string) =>
    withTenant(
      worker.db.rw,
      { tenantId: seed.tenant, actorId: seed.human, requestId: await uuidv7(worker.db.admin) },
      (tx) =>
        tx`insert into app.idempotency_key (tenant_id, principal_id, key, request_hash, response_code, expires_at) values (${seed.tenant}, ${seed.human}, ${key}, sha256('x'), 200, ${expiresAt}::timestamptz)`,
    );
  const keys = async (seed: Seed) =>
    withTenant(
      worker.db.rw,
      { tenantId: seed.tenant, actorId: seed.human, requestId: await uuidv7(worker.db.admin) },
      (tx) => tx<{ key: string }[]>`select key from app.idempotency_key order by key`,
    );
  const purge = async (seed: Seed) =>
    worker.run("admin.idempotency_key.purge", {
      tenantId: seed.tenant,
      requestId: await uuidv7(worker.db.admin),
      payload: {},
    });

  it("deletes only expired keys for its tenant", async () => {
    await insertKey(alpha, "a-expired", "2026-01-01T00:00:00Z");
    await insertKey(alpha, "a-live", "2099-01-01T00:00:00Z");
    await insertKey(beta, "b-expired", "2026-01-01T00:00:00Z");
    await purge(alpha);
    expect((await keys(alpha)).map((row) => row.key)).toEqual(["a-live"]);
    expect((await keys(beta)).map((row) => row.key)).toEqual(["b-expired"]);
  });

  it("reports its count and is idempotent", async () => {
    await insertKey(alpha, "a-expired-2", "2026-01-01T00:00:00Z");
    await purge(alpha);
    expect(worker.logs.at(-1)!.fields["purged"]).toBe(1);
    await purge(alpha);
    expect(worker.logs.at(-1)!.fields["purged"]).toBe(0);
  });
});
