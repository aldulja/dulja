import { afterAll, describe, expect, it } from "bun:test";
import { startWorkerHealth, type WorkerHealth } from "../src/health";

describe("worker health", () => {
  const server = startWorkerHealth(
    () => ["accounting.ledger.integrity_check", "admin.idempotency_key.purge"],
    0,
  );
  afterAll(() => server.stop());
  it("reports registered jobs", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const body = (await response.json()) as WorkerHealth;
    expect(response.status).toBe(200);
    expect(body.jobs).toEqual(["accounting.ledger.integrity_check", "admin.idempotency_key.purge"]);
    expect(Date.parse(body.startedAt)).not.toBeNaN();
  });
  it("serves nothing else", async () => {
    expect((await fetch(`http://127.0.0.1:${server.port}/v1/companies`)).status).toBe(404);
  });
});
