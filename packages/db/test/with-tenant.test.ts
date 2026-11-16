import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { resolvePrincipal, systemContext, withTenant } from "../src/with-tenant";
import { seedTenant, type Seed } from "./fixtures";
import { startDb, type Db, uuidv7 } from "./harness";

function context(seed: Seed) {
  return { tenantId: seed.tenant, actorId: seed.human, requestId: "request-1" };
}

describe("production withTenant", () => {
  let db: Db;
  let alpha: Seed;
  let beta: Seed;
  let rw: Sql;
  beforeAll(async () => {
    db = await startDb();
    alpha = await seedTenant(db, "Alpha");
    beta = await seedTenant(db, "Beta");
    rw = createDb(db.url("app_rw"));
  });
  afterAll(async () => {
    await rw.end();
    await db.stop();
  });
  it("opens at read committed and sets the tenant and actor before the callback", async () => {
    const result = await withTenant(rw, context(alpha), async (tx) => {
      const [row] = await tx<
        { level: string; tenant: string; actor: string }[]
      >`select current_setting('transaction_isolation') level, app.current_tenant()::text tenant, app.current_actor()::text actor`;
      return row;
    });
    expect(result).toEqual({
      level: "read committed",
      tenant: alpha.tenant,
      actor: alpha.human,
    });
  });
  it("isolates tenant rows", async () => {
    const ids = await withTenant(rw, context(alpha), async (tx) =>
      (await tx<{ id: string }[]>`select id from app.company`).map((row) => row.id),
    );
    expect(ids).toEqual([alpha.company]);
  });
  it("rejects missing and nested context", async () => {
    await expect(
      withTenant(rw, { tenantId: "", actorId: alpha.human, requestId: "r" }, async () => 1),
    ).rejects.toThrow("ERR_TENANT_CONTEXT_MISSING");
    await expect(
      withTenant(rw, { tenantId: alpha.tenant, actorId: "", requestId: "r" }, async () => 1),
    ).rejects.toThrow("ERR_TENANT_CONTEXT_MISSING");
    await expect(
      withTenant(rw, context(alpha), (tx) => withTenant(tx, context(alpha), async () => 1)),
    ).rejects.toThrow("ERR_TENANT_CONTEXT_NESTED");
  });
  it("retries a serialization error once and does not retry anything else", async () => {
    let calls = 0;
    const error = Object.assign(new Error("retry"), { code: "40001" });
    await expect(
      withTenant(rw, context(alpha), async () => {
        calls += 1;
        throw error;
      }),
    ).rejects.toThrow("retry");
    expect(calls).toBe(2);

    // A unique violation is the caller's problem, not a lost race: one attempt, and the retry stays bounded.
    calls = 0;
    const duplicate = Object.assign(new Error("boom"), { code: "23505" });
    await expect(
      withTenant(rw, context(alpha), async () => {
        calls += 1;
        throw duplicate;
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
  it("retries a real deadlock between two connections and both transactions finish", async () => {
    const deadlocks = async () =>
      (
        await db.admin<
          { n: number }[]
        >`select deadlocks::int n from pg_stat_database where datname = current_database()`
      )[0]!.n;
    const before = await deadlocks();
    const other = createDb(db.url("app_rw"), { max: 1 });
    try {
      const first = await uuidv7(db.admin);
      const second = await uuidv7(db.admin);
      await withTenant(
        rw,
        context(alpha),
        (tx) => tx`insert into app.role (id, tenant_id, code, name_en) values
          (${first}, ${alpha.tenant}, 'x1', 'X1'), (${second}, ${alpha.tenant}, 'x2', 'X2')`,
      );
      // Two transactions taking the same two rows in opposite order; PostgreSQL kills one with 40P01.
      const forward = withTenant(rw, context(alpha), async (tx) => {
        await tx`update app.role set name_en = 'A1' where id = ${first}`;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx`update app.role set name_en = 'A2' where id = ${second}`;
        return "forward";
      });
      const backward = withTenant(other, context(alpha), async (tx) => {
        await tx`update app.role set name_en = 'B2' where id = ${second}`;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await tx`update app.role set name_en = 'B1' where id = ${first}`;
        return "backward";
      });
      expect(await Promise.all([forward, backward])).toEqual(["forward", "backward"]);
      expect(await deadlocks()).toBeGreaterThan(before); // the loser really was killed, and really retried
    } finally {
      await other.end();
    }
  });
  it("resolves principals only through the pre-tenant function", async () => {
    expect(await resolvePrincipal(rw, `system:${alpha.tenant}`)).toEqual([
      { principalId: alpha.system, tenantId: alpha.tenant, kind: "system" },
    ]);
    expect(await resolvePrincipal(rw, "unknown")).toEqual([]);
  });
  it("builds a tenant system context and refuses a tenant that has none", async () => {
    expect(await systemContext(rw, alpha.tenant, "req-a")).toEqual({
      tenantId: alpha.tenant,
      actorId: alpha.system,
      requestId: "req-a",
    });
    expect(await systemContext(rw, beta.tenant, "req-b")).toEqual({
      tenantId: beta.tenant,
      actorId: beta.system,
      requestId: "req-b",
    });
    await expect(systemContext(rw, await uuidv7(db.admin), "req-c")).rejects.toThrow(
      "ERR_TENANT_CONTEXT_MISSING",
    );
  });
});
