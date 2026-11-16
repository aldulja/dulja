import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import {
  moneyOutFixture,
  postEmployeeAdvance,
  type MoneyOutFixture,
} from "../../../../../tests/invariants/support/payroll-money";

// 8C T6 — the employee-advances route module over HTTP (spec:2082). `s.human` holds the seeded hr_payroll shape
// (read, prepare, pay, advance.create); `f.payer` holds accounting.payment.approve and .post only.

let api: StartedApi;
let s: Seed;
let f: MoneyOutFixture;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "ADV routes");
  f = await moneyOutFixture(api.db, s);
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => {
  await api.stop();
});

const path = () => `/v1/companies/${s.company}/employee-advances`;
const body = (over: Record<string, unknown> = {}) => ({
  employeeId: f.employeeAId,
  effectiveDate: "2026-01-10",
  branchId: s.hq,
  amount: { amount: "250.0000", currency: "MYR" },
  reason: "Advance against February",
  ...over,
});
type Advance = {
  documentId: string;
  status: string;
  number: string | null;
  series: string;
  employeeId: string;
  employeeNumber: string;
  amount: { amount: string; currency: string };
  reason: string;
};

describe("POST /v1/companies/{companyId}/employee-advances", () => {
  it("403s a principal without hr.advance.create", async () => {
    const res = await api.request({ method: "POST", path: path(), as: f.payer, body: body() });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s without an Idempotency-Key", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      idempotencyKey: null,
      body: body(),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("201s a DRAFT for the payroll officer and returns the amount in MoneySchema's shape", async () => {
    const res = await api.request({ method: "POST", path: path(), as: s.human, body: body() });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Advance;
    expect(created.status).toBe("draft");
    expect(created.series).toBe("ADV");
    expect(created.number).toBeNull(); // numbering is at issue (§4.3.6)
    expect(created.amount).toEqual({ amount: "250.0000", currency: "MYR" });
    expect(created.reason).toBe("Advance against February");
    expect(created.employeeId).toBe(f.employeeAId);
    expect(created.employeeNumber).toBe("E-0001");
  });

  it("400s an amount in a currency that is not the company's base currency (the service's ERR_VALIDATION_FAILED)", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body({ amount: { amount: "250.0000", currency: "USD" } }),
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/base currency MYR, not USD/);
  });

  it("400s a non-positive amount, with the service's own sentence", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body({ amount: { amount: "0.0000", currency: "MYR" } }),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toMatch(/an advance must be greater than zero/);
  });

  it("404s an employee who is not in the path's company, and 400s a blank reason", async () => {
    const stranger = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body({ employeeId: "00000000-0000-7000-8000-000000000000" }),
    });
    expect(stranger.status).toBe(404);
    const blank = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body({ reason: "   " }),
    });
    expect(blank.status).toBe(400);
  });
});

describe("GET /v1/companies/{companyId}/employee-advances", () => {
  it("lists one employee's advances newest first and pages with a cursor", async () => {
    // A second, later advance for the same employee, so a `limit=1` page has something after it.
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body({ effectiveDate: "2026-01-20", amount: { amount: "50.0000", currency: "MYR" } }),
    });
    expect(res.status).toBe(201);

    const first = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}?filter[employeeId][eq]=${f.employeeAId}&limit=1`,
    });
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { items: Advance[]; next_cursor: string | null };
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.amount.amount).toBe("50.0000"); // 2026-01-20, the newer one
    expect(page1.next_cursor).not.toBeNull();

    const second = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}?filter[employeeId][eq]=${f.employeeAId}&limit=1&cursor=${page1.next_cursor}`,
    });
    const page2 = (await second.json()) as { items: Advance[]; next_cursor: string | null };
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.amount.amount).toBe("250.0000");
    expect(page2.next_cursor).toBeNull();

    const other = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}?filter[employeeId][eq]=${f.employeeBId}`,
    });
    expect(((await other.json()) as { items: Advance[] }).items).toHaveLength(0);
  });

  it("404s an id that does not resolve, and a payroll payment's id — never a 200", async () => {
    for (const id of ["00000000-0000-7000-8000-000000000000", f.payrollDocumentId]) {
      const res = await api.request({ method: "GET", as: s.human, path: `${path()}/${id}` });
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    }
  });
});

describe("GET /v1/companies/{companyId}/employee-advances/balances/{employeeId}", () => {
  it("returns the LEDGER figure for a POSTED advance, as of a named date — a draft does not count", async () => {
    const posted = await postEmployeeAdvance(api.db, s, f, {
      employeeId: f.employeeBId,
      amount: "100.0000",
      reason: "balance case",
    });
    expect(posted).toBeTruthy();
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}/balances/${f.employeeBId}?asOf=2026-01-31`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      employeeId: f.employeeBId,
      asOf: "2026-01-31",
      balance: { amount: "100.0000", currency: "MYR" },
    });
    // Employee A's two advances are drafts: nothing in the ledger.
    const drafts = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}/balances/${f.employeeAId}?asOf=2026-01-31`,
    });
    expect(((await drafts.json()) as { balance: { amount: string } }).balance.amount).toBe(
      "0.0000",
    );
  });

  it("400s without asOf — a balance never defaults to the clock (spec:2039)", async () => {
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}/balances/${f.employeeBId}`,
    });
    expect(res.status).toBe(400);
  });

  it("404s an employee who is not in the path's company", async () => {
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}/balances/00000000-0000-7000-8000-000000000000?asOf=2026-01-31`,
    });
    expect(res.status).toBe(404);
  });
});
