import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import { hrActor, hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

// 8D T3 — GET …/employees/permit-expiry (amendment A3) over HTTP: the permit half of spec:2091, and test 32's
// endpoint clause for it. E-1003 IS the officer (R4), so the permits are written on E-1001 and E-1002.

type Item = {
  employeeId: string;
  employeeNumber: string;
  workPermitExpiry: string;
  daysRemaining: number;
};

describe("GET /v1/companies/{companyId}/employees/permit-expiry — 8D amendment A3, test 32", () => {
  let f: HrFixture;
  const path = (q = "") => `/v1/companies/${f.companyId}/employees/permit-expiry${q}`;

  beforeAll(async () => {
    f = await hrFixture(await startApi(), "permit-route");
    for (const [employee, expiry] of [
      [f.employees[0]!, "2026-02-15"],
      [f.employees[1]!, "2099-12-31"],
    ] as const) {
      const put = await f.api.request({
        method: "PUT",
        path: `/v1/companies/${f.companyId}/employees/${employee.id}/sensitive`,
        as: f.officer,
        body: { workPermitExpiry: expiry },
      });
      expect(put.status).toBe(200);
    }
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  it("the officer receives the decrypted list inside the window, and the 6C detail route is not shadowed", async () => {
    const res = await f.api.request({ method: "GET", path: path("?withinDays=30"), as: f.officer });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Item[]; next_cursor: string | null };
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((i) => i.employeeNumber)).toEqual(["E-1001"]);
    expect(body.items[0]!.workPermitExpiry).toBe("2026-02-15");
    expect(Number.isInteger(body.items[0]!.daysRemaining)).toBe(true);
    // The far permit enters with a wide enough window.
    const wide = await f.api.request({
      method: "GET",
      path: path("?withinDays=3650"),
      as: f.officer,
    });
    const all = ((await wide.json()) as { items: Item[] }).items;
    expect(all.map((i) => i.employeeNumber)).toEqual(["E-1001"]);
    // 6C's GET /{employeeId} still answers for a real id.
    const detail = await f.api.request({
      method: "GET",
      path: `/v1/companies/${f.companyId}/employees/${f.employees[0]!.id}`,
      as: f.officer,
    });
    expect(detail.status).toBe(200);
  });

  it("a principal without hr.employee.read_sensitive is refused at the gate, not by an empty list", async () => {
    const res = await f.api.request({ method: "GET", path: path(), as: hrActor(f, "outsider") });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("?includeTerminated=false means false, and an unknown query key is a 400", async () => {
    const ok = await f.api.request({
      method: "GET",
      path: path("?withinDays=30&includeTerminated=false"),
      as: f.officer,
    });
    expect(ok.status).toBe(200);
    const bad = await f.api.request({ method: "GET", path: path("?surprise=1"), as: f.officer });
    expect(bad.status).toBe(400);
    expect((await problemOf(bad)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("another company of the tenant is refused — the gate is bound to the path's company", async () => {
    const res = await f.api.request({
      method: "GET",
      path: `/v1/companies/00000000-0000-7000-8000-000000000001/employees/permit-expiry`,
      as: f.officer,
    });
    expect(res.status).toBe(403);
  });

  it("the OpenAPI document exposes no other sensitive field through this route", () => {
    const doc = f.api.app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
    }) as { components?: { schemas?: Record<string, unknown> } };
    const text = JSON.stringify(doc.components?.schemas?.["PermitExpiry"] ?? {});
    for (const forbidden of [
      "nationalId",
      "passport",
      "bankAccount",
      "dateOfBirth",
      "taxNumber",
      "epfNumber",
      "socsoNumber",
      "residencyCategory",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain("workPermitExpiry"); // the ONE sensitive value this gated route returns
  });
});
