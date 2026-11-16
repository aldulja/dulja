import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JOBS, type JobName, type JobPayload } from "@dulja/db";
import { seedTenant, grantCodes, uuidv7, type Seed } from "@dulja/db/test";
import { registeredJobNames } from "@dulja/worker/handler";
import { startWorker, type StartedWorker } from "@dulja/worker/test-support";
import { JOB_PROBES } from "./probes";

describe("tenant isolation across every registered job", () => {
  let worker: StartedWorker;
  let attacker: Seed;
  let victim: Seed;
  beforeAll(async () => {
    worker = await startWorker();
    attacker = await seedTenant(worker.db, "Attacker");
    victim = await seedTenant(worker.db, "Victim");
    await grantCodes(worker.db, attacker);
    await grantCodes(worker.db, victim);
  });
  afterAll(async () => {
    await worker.stop();
  });

  it("keeps handler and probe registries in sync", () => {
    const registered = registeredJobNames();
    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered)
      expect(JOB_PROBES[name], `no JOB_PROBES entry for ${name}`).toBeDefined();
    for (const name of Object.keys(JOB_PROBES) as JobName[]) {
      expect(registered).toContain(name);
      expect(JOBS[name]).toBeDefined();
    }
  });

  it("a job run for tenant A touches no row of tenant B", async () => {
    for (const name of registeredJobNames()) {
      const probe = JOB_PROBES[name]!;
      await probe.seed(worker.db, attacker, victim);
      const before = await probe.survivors(worker.db, victim);
      const attempt = worker.run(name, {
        tenantId: attacker.tenant,
        requestId: await uuidv7(worker.db.admin),
        // One shape for every job (0d:2733–2741), so the probe's payload is typed as the job's: since 9B every
        // `JobName` has a `JobPayload` key, and `unknown` no longer widens the union.
        payload: (probe.payload
          ? await probe.payload(worker.db, attacker, victim)
          : {}) as JobPayload[typeof name],
      });
      if (probe.expectedErrorCode)
        await expect(attempt).rejects.toMatchObject({ code: probe.expectedErrorCode });
      else await attempt;
      expect(await probe.survivors(worker.db, victim), name).toBe(before);
    }
  });

  it("uses the envelope tenant and its system principal", async () => {
    await worker.run("admin.idempotency_key.purge", {
      tenantId: victim.tenant,
      requestId: await uuidv7(worker.db.admin),
      payload: {},
    });
    const line = worker.logs.at(-1)!;
    expect(line.fields["tenant_id"]).toBe(victim.tenant);
    expect(line.fields["actor_id"]).toBe(victim.system);
  });
});
