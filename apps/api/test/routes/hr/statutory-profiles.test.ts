import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api"; // 0B's, imported directly
import { hrFixture, type HrFixture } from "../../../../../tests/invariants/support/hr";

describe("GET|POST /v1/companies/{companyId}/employees/{employeeId}/statutory-profiles", () => {
  let f: HrFixture;
  let target: string;
  beforeAll(async () => {
    f = await hrFixture(await startApi(), "hr-profiles");
    target = f.employees[0]!.id;
  }, 240_000);
  afterAll(async () => {
    await f.api.stop();
  });

  const path = (employeeId: string) =>
    `/v1/companies/${f.companyId}/employees/${employeeId}/statutory-profiles`;
  const open = (as: string, employeeId: string, body: Record<string, unknown>) =>
    f.api.request({ method: "POST", path: path(employeeId), as, body });
  const single = {
    effectiveFrom: "2026-01-01",
    maritalStatus: "single",
    spouseWorking: null,
    childReliefCount: 0,
    residencyCategory: null,
  };

  it("the officer opens two profiles and the first comes back closed", async () => {
    expect((await open(f.officer, target, single)).status).toBe(201);
    const second = await open(f.officer, target, {
      effectiveFrom: "2026-07-01",
      maritalStatus: "married",
      spouseWorking: true,
      childReliefCount: 2,
      residencyCategory: null,
    });
    expect(second.status).toBe(201);
    expect(((await second.json()) as { enteredBy: string }).enteredBy).toBe(f.officer);
    const res = await f.api.request({ method: "GET", path: path(target), as: f.officer });
    const body = (await res.json()) as {
      items: {
        effectiveFrom: string;
        effectiveTo: string | null;
        childReliefCount: number | null;
      }[];
      next_cursor: string | null;
    };
    expect(body.items.map((i) => [i.effectiveFrom, i.effectiveTo])).toEqual([
      ["2026-07-01", null],
      ["2026-01-01", "2026-06-30"],
    ]);
    expect(body.items[0]!.childReliefCount).toBe(2);
    expect(body.next_cursor).toBeNull();
  });

  it("a principal without hr.compensation.read is refused on BOTH verbs (test 32)", async () => {
    const get = await f.api.request({ method: "GET", path: path(target), as: f.outsider });
    expect(get.status).toBe(403);
    expect((await problemOf(get)).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((await open(f.outsider, target, single)).status).toBe(403);
  });

  it("R4: the officer cannot open a profile on their OWN employee row (test 31)", async () => {
    const self = f.employees.find((e) => e.principalId === f.officer)!;
    const res = await open(f.officer, self.id, single);
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_HR_SELF_PAY");
  });

  it("the ⚠️ OD-28 seam round-trips: extra is stored and returned unchanged", async () => {
    const other = f.employees[1]!.id;
    const res = await open(f.officer, other, {
      effectiveFrom: "2026-01-01",
      maritalStatus: null,
      spouseWorking: null,
      childReliefCount: null,
      residencyCategory: null,
      extra: { verified_field_a: "value", verified_flag_b: true },
    });
    expect(res.status).toBe(201);
    const get = await f.api.request({ method: "GET", path: path(other), as: f.officer });
    const body = (await get.json()) as { items: { extra: Record<string, unknown> }[] };
    expect(body.items[0]!.extra).toEqual({ verified_field_a: "value", verified_flag_b: true });
  });

  // `filter[…]` and `limit` are refused by `StatutoryProfileQuery`'s `.strict()`; `sort` and `fields` by their
  // `.max(0, …)` bounds.
  it("a sensitive-looking sort or filter is ERR_VALIDATION_FAILED — no undeclared field reaches SQL", async () => {
    for (const q of [
      "sort=maritalStatus",
      "filter[maritalStatus][eq]=married",
      "fields=extra",
      "limit=1",
    ]) {
      const res = await f.api.request({
        method: "GET",
        path: `${path(target)}?${q}`,
        as: f.officer,
      });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("a server-owned field in the body is refused, not silently dropped", async () => {
    const res = await open(f.officer, target, {
      ...single,
      effectiveFrom: "2028-01-01",
      enteredBy: f.checker,
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("POST without Idempotency-Key is refused like every other unsafe route", async () => {
    const res = await f.api.request({
      method: "POST",
      path: path(target),
      as: f.officer,
      body: { ...single, effectiveFrom: "2028-01-01" },
      idempotencyKey: null,
    });
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
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
