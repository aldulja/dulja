import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("compensation lines over HTTP — and test 31's R4 clause through the API", () => {
  let f: HrFixture;
  let target: string;
  let basic: string;
  const path = (employeeId: string) =>
    `/v1/companies/${f.companyId}/employees/${employeeId}/compensation-lines`;

  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-compensation");
    target = f.employees[0]!.id;
    const res = await f.api.request({
      method: "POST",
      path: `/v1/companies/${f.companyId}/pay-components`,
      as: f.officer,
      body: { code: "BASIC", nameEn: "Basic salary", kind: "earning", quantityBased: false },
    });
    expect(res.status).toBe(201);
    basic = ((await res.json()) as { id: string }).id;
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  it("opens a line and reads it back with a Money-shaped amount", async () => {
    const post = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: {
        componentId: basic,
        effectiveFrom: "2026-01-01",
        amount: { amount: "3500.0000", currency: "MYR" },
      },
    });
    expect(post.status).toBe(201);
    expect(((await post.json()) as { enteredBy: string }).enteredBy).toBe(f.officer);
    const get = await f.api.request({ method: "GET", path: path(target), as: f.officer });
    const body = (await get.json()) as {
      items: { amount: { amount: string; currency: string } | null; effectiveTo: string | null }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.amount).toEqual({ amount: "3500.0000", currency: "MYR" });
    expect(body.items[0]!.effectiveTo).toBeNull();
  });

  it("a raise closes the previous line in the same request, and the as-of filter reads either side", async () => {
    const raise = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: {
        componentId: basic,
        effectiveFrom: "2026-07-01",
        amount: { amount: "4000.0000", currency: "MYR" },
      },
    });
    expect(raise.status).toBe(201);
    const get = await f.api.request({ method: "GET", path: path(target), as: f.officer });
    const body = (await get.json()) as {
      items: { effectiveFrom: string; effectiveTo: string | null }[];
    };
    expect(body.items.map((i) => [i.effectiveFrom, i.effectiveTo])).toEqual([
      ["2026-07-01", null],
      ["2026-01-01", "2026-06-30"],
    ]);
    for (const [on, amount] of [
      ["2026-03-15", "3500.0000"],
      ["2026-09-15", "4000.0000"],
    ] as const) {
      const res = await f.api.request({
        method: "GET",
        path: `${path(target)}?filter[effectiveOn][eq]=${on}&filter[componentId][eq]=${basic}`,
        as: f.officer,
      });
      const items = ((await res.json()) as { items: { amount: { amount: string } }[] }).items;
      expect(items.map((i) => i.amount.amount)).toEqual([amount]);
    }
  });

  it("test 31 R4: the officer cannot open a line on their OWN employee row through the API", async () => {
    const self = f.employees.find((e) => e.principalId === f.officer)!;
    const res = await f.api.request({
      method: "POST",
      path: path(self.id),
      as: f.officer,
      body: {
        componentId: basic,
        effectiveFrom: "2026-01-01",
        amount: { amount: "99999.0000", currency: "MYR" },
      },
    });
    expect(res.status).toBe(409);
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_HR_SELF_PAY");
    expect(p.detail).toContain(f.officer);
  });

  it("test 32: a principal without hr.compensation.read gets 403, and the list carries no amount", async () => {
    const res = await f.api.request({ method: "GET", path: path(target), as: f.outsider });
    expect(res.status).toBe(403);
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(JSON.stringify(p)).not.toContain("3500");
  });

  // Two different mechanisms, one assertion: `filter[amount][gt]` and `limit` are undeclared keys and die on
  // `CompensationQuery`'s `.strict()`; `sort` is declared and dies on its `.max(0, …)` bound.
  it("test 32: amount is not a declared filter or sort field", async () => {
    for (const q of ["filter[amount][gt]=1000", "sort=-amount", "fields=amount", "limit=1"]) {
      const res = await f.api.request({
        method: "GET",
        path: `${path(target)}?${q}`,
        as: f.officer,
      });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("an amount with the wrong scale is refused by MoneySchema before it reaches SQL", async () => {
    const res = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: {
        componentId: basic,
        effectiveFrom: "2027-01-01",
        amount: { amount: "4000.00", currency: "MYR" },
      },
    });
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("an amount outside the company's base currency is ERR_MONEY_CURRENCY_MISMATCH (spec:2093)", async () => {
    const res = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: {
        componentId: basic,
        effectiveFrom: "2027-01-01",
        amount: { amount: "4000.0000", currency: "USD" },
      },
    });
    expect(res.status).toBe(422);
    expect((await problemOf(res)).code).toBe("ERR_MONEY_CURRENCY_MISMATCH");
  });

  it("a line with neither amount nor quantity is refused", async () => {
    const res = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: { componentId: basic, effectiveFrom: "2027-06-01" },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("an unknown pay component is 404, and an archived one is refused", async () => {
    const unknown = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: {
        componentId: "00000000-0000-7000-8000-0000000000fe",
        effectiveFrom: "2027-06-01",
        amount: { amount: "1.0000", currency: "MYR" },
      },
    });
    expect(unknown.status).toBe(404);
    const created = await f.api.request({
      method: "POST",
      path: `/v1/companies/${f.companyId}/pay-components`,
      as: f.officer,
      body: { code: "RETIRED", nameEn: "Retired allowance", kind: "earning" },
    });
    const retired = ((await created.json()) as { id: string }).id;
    await f.api.request({
      method: "POST",
      path: `/v1/companies/${f.companyId}/pay-components/${retired}/archive`,
      as: f.officer,
    });
    const res = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: {
        componentId: retired,
        effectiveFrom: "2027-06-01",
        amount: { amount: "1.0000", currency: "MYR" },
      },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toContain("archived");
  });

  it("an employee of another tenant is 404", async () => {
    const res = await f.api.request({
      method: "GET",
      path: path("00000000-0000-7000-8000-0000000000ff"),
      as: f.officer,
    });
    expect(res.status).toBe(404);
  });
});
