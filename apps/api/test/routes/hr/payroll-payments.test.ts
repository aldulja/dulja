import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import { secondApprover } from "../../../../../tests/invariants/support/payroll";
import {
  moneyOutFixture,
  type MoneyOutFixture,
} from "../../../../../tests/invariants/support/payroll-money";

// 8C T6 — the payroll-payments route module over HTTP (spec:2082/2083). Figures come from 8B's SYNTH table through
// payrollFixture: net 1950.0000 per employee (hazard 1). `s.human` holds the seeded hr_payroll shape (read, prepare,
// pay, advance.create); `f.payer` holds accounting.payment.approve and .post only.

let api: StartedApi;
let s: Seed;
let f: MoneyOutFixture;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "PAYB routes");
  f = await moneyOutFixture(api.db, s);
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => {
  await api.stop();
});

const path = () => `/v1/companies/${s.company}/payroll-payments`;
const body = (extra: Record<string, unknown> = {}) => ({
  payrollDocumentId: f.payrollDocumentId,
  effectiveDate: "2026-02-05",
  branchId: s.hq,
  ...extra,
});
type Batch = {
  documentId: string;
  series: string;
  number: string | null;
  status: string;
  payrollDocumentId: string;
  employeeCount: number;
  total: { amount: string; currency: string };
  lines: { employeeId: string; amount: { amount: string; currency: string }; branchId: string }[];
};

describe("POST /v1/companies/{companyId}/payroll-payments", () => {
  it("403s a principal without hr.payroll.pay (the payer holds accounting.payment.* only)", async () => {
    const res = await api.request({ method: "POST", path: path(), as: f.payer, body: body() });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s without an Idempotency-Key (spec:2055)", async () => {
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

  it("400s an unknown member or a malformed date", async () => {
    for (const extra of [
      { surprise: true },
      { effectiveDate: "2026-02-30" },
      { employeeIds: [] },
    ]) {
      const res = await api.request({
        method: "POST",
        path: path(),
        as: s.human,
        body: body(extra),
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("201s a DRAFT batch for the payroll officer and replays the same key", async () => {
    const key = crypto.randomUUID();
    const first = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body(),
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const batch = (await first.json()) as Batch;
    expect(batch.status).toBe("draft");
    expect(batch.series).toBe("PAYB");
    expect(batch.number).toBeNull(); // numbering is at issue (§4.3.6)
    expect(batch.payrollDocumentId).toBe(f.payrollDocumentId);
    expect(batch.employeeCount).toBe(2);
    expect(batch.total).toEqual({ amount: "3900.0000", currency: "MYR" });
    expect(batch.lines.map((l) => l.branchId).toSorted()).toEqual([s.hq, f.branchB].toSorted());

    const second = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body(),
      idempotencyKey: key,
    });
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(batch);

    // A NEW key is a new request: every employee is on the draft already, so it is refused, never a second batch.
    const again = await api.request({ method: "POST", path: path(), as: s.human, body: body() });
    expect(again.status).toBe(400);
    const problem = await problemOf(again);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/every employee on payroll run .* is already paid/);
  });

  it("404s a run that is not in the path's company", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: body({ payrollDocumentId: "00000000-0000-7000-8000-000000000000" }),
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });
});

describe("the batch's lifecycle runs on 2B's GENERIC transitions route (R1, accounting.payment.*)", () => {
  it("the preparer submits, may not approve; the payer approves and posts; the batch is then numbered", async () => {
    const list = await api.request({
      method: "GET",
      path: `${path()}?filter[payrollDocumentId][eq]=${f.payrollDocumentId}`,
      as: s.human,
    });
    expect(list.status).toBe(200);
    const page = (await list.json()) as { items: Batch[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBeNull();
    const id = page.items[0]!.documentId;
    const t = (to: string, as: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${id}/transitions`,
        as,
        body: { to },
      });
    expect((await t("submitted", s.human)).status).toBe(200);
    // R2: the preparer does not hold accounting.payment.approve, which the PAYROLL_PAYMENT policy resolves.
    const selfApprove = await t("approved", s.human);
    expect(selfApprove.status).toBe(403);
    expect((await problemOf(selfApprove)).code).toBe("ERR_RBAC_FORBIDDEN");
    expect((await t("approved", f.payer)).status).toBe(200);
    expect((await t("posted", f.payer)).status).toBe(200);

    const after = await api.request({ method: "GET", path: `${path()}/${id}`, as: s.human });
    expect(after.status).toBe(200);
    const posted = (await after.json()) as Batch;
    expect(posted.status).toBe("posted");
    expect(posted.number).not.toBeNull();
  });
});

describe("GET /v1/companies/{companyId}/payroll-payments …", () => {
  it("403s a principal without hr.payroll.read", async () => {
    const res = await api.request({ method: "GET", path: path(), as: f.payer });
    expect(res.status).toBe(403);
  });

  it("404s a document that is not a payroll payment — a PAYROLL run named by id", async () => {
    const res = await api.request({
      method: "GET",
      path: `${path()}/${f.payrollDocumentId}`,
      as: s.human,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("400s an unknown query parameter and a hand-made cursor", async () => {
    for (const q of ["?status=posted", "?cursor=bm90LWEtY3Vyc29y"]) {
      const res = await api.request({ method: "GET", path: `${path()}${q}`, as: s.human });
      expect(res.status, q).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("…/{id}/csv returns text/csv with the six-column header, one row per employee, a masked account", async () => {
    const list = await api.request({ method: "GET", path: `${path()}?limit=1`, as: s.human });
    const { items } = (await list.json()) as { items: Batch[] };
    const batch = items[0]!;
    const csv = await api.request({
      method: "GET",
      path: `${path()}/${batch.documentId}/csv`,
      as: s.human,
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("attachment");
    const [header, ...rows] = (await csv.text()).split("\r\n");
    expect(header).toBe("employee_number,employee_name,bank_account,amount,currency,reference");
    expect(rows.at(-1)).toBe(""); // CRLF-terminated
    const data = rows.slice(0, -1);
    expect(data).toHaveLength(2);
    for (const row of data) {
      const cells = row.split(",");
      expect(cells[2]).toBe("****");
      expect(cells[3]).toBe("1950.0000");
      expect(cells[4]).toBe("MYR");
      expect(cells[5]).toBe(`PAYB-${batch.number}`);
    }
  });
});

describe("a principal who holds hr.payroll.pay but not hr.payroll.read", () => {
  it("drafts but cannot list (the two codes gate two different things)", async () => {
    const releaser = await secondApprover(api.db, s, ["hr.payroll.pay"]);
    await api.loadPrincipals();
    const res = await api.request({ method: "GET", path: path(), as: releaser });
    expect(res.status).toBe(403);
  });
});
