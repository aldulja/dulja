import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedCurrency, seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const path = (seed: Seed, suffix = "") => `/v1/companies/${seed.company}/exchange-rates${suffix}`;

describe("/v1/companies/{companyId}/exchange-rates", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  /** A second company inside tenant A, which a.human's single assignment does not reach. */
  let secondCompany: string;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grantAdmin(api, a);
    await grantAdmin(api, b);
    // MYR arrives with the tenant; only the foreign side is this suite's to seed.
    await seedCurrency(api.db, a, { code: "USD" });
    secondCompany = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`insert into app.company (id, tenant_id, code, name, base_currency)
                 values (${secondCompany}, ${a.tenant}, 'SECOND', 'Alpha second company', 'MYR')`,
    );
  });
  afterAll(async () => api.stop());

  const lookupPath = (seed: Seed, from: string, to: string, on: string) => {
    const query = new URLSearchParams({ from, to, on });
    return `${path(seed, "/lookup")}?${query.toString()}`;
  };
  const body = {
    fromCurrency: "USD",
    toCurrency: "MYR",
    rate: "4.68000000",
    effectiveFrom: "2026-01-01",
    source: "BNM 2026-01-01",
  };

  it("creates a rate and stamps enteredBy", async () => {
    const res = await api.request({ method: "POST", path: path(a), body, as: a.human });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      rate: "4.68000000",
      enteredBy: a.human,
      source: "BNM 2026-01-01",
    });
  });

  it("validates numeric(19,8) positive rates", async () => {
    for (const rate of ["4.68", "-1.00000000", "abc"]) {
      const res = await api.request({
        method: "POST",
        path: path(a),
        body: { ...body, rate, effectiveFrom: "2026-02-01" },
        as: a.human,
      });
      expect(res.status, rate).toBe(400);
      const problem = (await res.json()) as Problem;
      expect(problem.code).toBe("ERR_VALIDATION_FAILED");
      expect(problem.errors?.some((error) => error.path.includes("rate"))).toBe(true);
    }
  });

  it("requires and replays an idempotency key", async () => {
    const missing = await api.request({
      method: "POST",
      path: path(a),
      body,
      as: a.human,
      idempotencyKey: null,
    });
    expect(((await missing.json()) as Problem).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const create = { ...body, effectiveFrom: "2026-03-01" };
    const first = await api.request({
      method: "POST",
      path: path(a),
      body: create,
      as: a.human,
      idempotencyKey: "rate-replay-1",
    });
    const second = await api.request({
      method: "POST",
      path: path(a),
      body: create,
      as: a.human,
      idempotencyKey: "rate-replay-1",
    });
    expect(first.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });

  it("paginates newest first", async () => {
    await api.request({
      method: "POST",
      path: path(a),
      body: { ...body, effectiveFrom: "2026-05-01" },
      as: a.human,
    });
    const first = await api.request({ method: "GET", path: `${path(a)}?limit=2`, as: a.human });
    const page = (await first.json()) as {
      items: { effectiveFrom: string }[];
      next_cursor: string | null;
    };
    expect(page.items.map((item) => item.effectiveFrom)).toEqual(["2026-05-01", "2026-03-01"]);
    expect(page.next_cursor).not.toBeNull();
    const next = await api.request({
      method: "GET",
      path: `${path(a)}?limit=2&cursor=${encodeURIComponent(page.next_cursor!)}`,
      as: a.human,
    });
    const rest = (await next.json()) as {
      items: { effectiveFrom: string }[];
      next_cursor: string | null;
    };
    expect(rest.items.map((item) => item.effectiveFrom)).toEqual(["2026-01-01"]);
    expect(rest.next_cursor).toBeNull();
  });

  it("looks up effective and identity rates", async () => {
    const found = await api.request({
      method: "GET",
      path: lookupPath(a, "USD", "MYR", "2026-02-15"),
      as: a.human,
    });
    expect(await found.json()).toMatchObject({ rate: "4.68000000", effectiveFrom: "2026-01-01" });
    const identity = await api.request({
      method: "GET",
      path: lookupPath(a, "MYR", "MYR", "1999-01-01"),
      as: a.human,
    });
    expect(await identity.json()).toMatchObject({ rate: "1.00000000", source: "unit" });
  });

  it("returns ERR_RATE_NOT_FOUND with the pair and date", async () => {
    const res = await api.request({
      method: "GET",
      path: lookupPath(a, "USD", "MYR", "2025-12-31"),
      as: a.human,
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_RATE_NOT_FOUND");
    expect(problem.detail).toContain("USD → MYR on 2025-12-31");
  });

  it("does not reveal another tenant's company", async () => {
    // 403 rather than 404 now that both reads carry a gate: the refusal lands before the handler.
    const cross = await api.request({ method: "GET", path: path(a), as: b.human });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("refuses a company of this tenant the caller does not administer", async () => {
    // The gate is per company, not per tenant: a.human holds admin.company.manage in a.company only.
    for (const suffix of ["", "/lookup?from=USD&to=MYR&on=2026-02-15"]) {
      const response = await api.request({
        method: "GET",
        path: `/v1/companies/${secondCompany}/exchange-rates${suffix}`,
        as: a.human,
      });
      expect(response.status, suffix).toBe(403);
      expect(((await response.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
    }
  });
});
