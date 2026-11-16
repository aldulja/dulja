import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedPayrollRun, seedTenantV2, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import { problemOf } from "../../../../../tests/support/api";
import { secondApprover } from "../../../../../tests/invariants/support/payroll";
import {
  moneyOutFixture,
  postRemittance,
  type MoneyOutFixture,
} from "../../../../../tests/invariants/support/payroll-money";

// 8C T7 — the statutory-schedule route module over HTTP (spec:2083). Figures come from 8B's SYNTH table through
// payrollFixture (hazard 1): employee share 50.0000 and employer share 100.0000 per employee, two employees.
// `s.human` holds the seeded hr_payroll shape (read, prepare, pay, advance.create, compensation.read);
// `f.payer` holds accounting.payment.approve and .post only.

let api: StartedApi;
let s: Seed;
let f: MoneyOutFixture;
let officer: string;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "Schedule routes");
  f = await moneyOutFixture(api.db, s);
  // Holds the two schedule codes but not hr.compensation.read, which the scheme references sit behind.
  officer = await secondApprover(api.db, s, ["hr.payroll.pay", "hr.payroll.read"]);
  await api.loadPrincipals();
}, 240_000);
afterAll(async () => {
  await api.stop();
});

const path = () => `/v1/companies/${s.company}/statutory-schedules`;
type Schedule = {
  scheduleId: string;
  schemeId: string;
  payrollDocumentId: string;
  totalEmployee: { amount: string; currency: string };
  totalEmployer: { amount: string; currency: string };
  attachmentId: string | null;
  remittanceDocumentId: string | null;
  employerRegistration: string | null;
  rows: { employeeId: string; employeeShare: string; employerShare: string }[];
};
let generated: Schedule;

describe("POST /v1/companies/{companyId}/statutory-schedules", () => {
  it("403s a principal without hr.payroll.pay", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: f.payer,
      body: { payrollDocumentId: f.payrollDocumentId },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s without an Idempotency-Key (spec:2055)", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      idempotencyKey: null,
      body: { payrollDocumentId: f.payrollDocumentId },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("400s an unknown member and an empty scheme list", async () => {
    for (const extra of [{ surprise: true }, { schemeIds: [] }]) {
      const res = await api.request({
        method: "POST",
        path: path(),
        as: s.human,
        body: { payrollDocumentId: f.payrollDocumentId, ...extra },
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
    }
  });

  it("403s a generator without hr.compensation.read, naming the code", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: officer,
      body: { payrollDocumentId: f.payrollDocumentId },
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toMatch(/hr\.compensation\.read/);
  });

  it("201s with both totals in MoneySchema's shape and the CSV attached, and replays the same key", async () => {
    const key = crypto.randomUUID();
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { payrollDocumentId: f.payrollDocumentId },
      idempotencyKey: key,
    });
    expect(res.status).toBe(201);
    const page = (await res.json()) as { items: Schedule[]; next_cursor: string | null };
    expect(page.next_cursor).toBeNull();
    expect(page.items).toHaveLength(1);
    generated = page.items[0]!;
    expect(generated.schemeId).toBe(f.schemeId);
    expect(generated.payrollDocumentId).toBe(f.payrollDocumentId);
    expect(generated.totalEmployee).toEqual({ amount: "100.0000", currency: "MYR" });
    expect(generated.totalEmployer).toEqual({ amount: "200.0000", currency: "MYR" });
    expect(generated.rows.map((r) => r.employeeId)).toEqual([f.employeeAId, f.employeeBId]);
    expect(generated.attachmentId).not.toBeNull(); // the CSV was attached with its sha256
    expect(generated.remittanceDocumentId).toBeNull(); // nothing has settled it yet
    // ⚠️ OD-23 (8C T15): the gap is a NULL in the payload, never an absent key — the client names the scheme.
    expect(generated).toHaveProperty("employerRegistration", null);

    const replay = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { payrollDocumentId: f.payrollDocumentId },
      idempotencyKey: key,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");

    // A NEW key regenerates: the same row and, the bytes unchanged, the same file.
    const again = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { payrollDocumentId: f.payrollDocumentId },
    });
    expect(again.status).toBe(201);
    const second = ((await again.json()) as { items: Schedule[] }).items[0]!;
    expect(second.scheduleId).toBe(generated.scheduleId);
    expect(second.attachmentId).toBe(generated.attachmentId);
  });

  it("409s a run that is not posted — ERR_DOC_STATUS_ILLEGAL is a state conflict (§4.2.4)", async () => {
    const draft = await seedPayrollRun(api.db, s, {
      periodStart: "2026-05-01",
      periodEnd: "2026-05-31",
      payDate: "2026-06-05",
      employeeIds: [f.employeeAId],
    });
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { payrollDocumentId: draft },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_STATUS_ILLEGAL");
  });

  it("404s a run id that is not a run of this company", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: s.human,
      body: { payrollDocumentId: "00000000-0000-7000-8000-000000000000" },
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });
});

describe("GET /v1/companies/{companyId}/statutory-schedules", () => {
  it("lists the unsettled schedules; a full last page carries no cursor", async () => {
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}?filter[settled][eq]=false&limit=10`,
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: Schedule[]; next_cursor: string | null };
    expect(page.items.map((i) => i.scheduleId)).toEqual([generated.scheduleId]);
    for (const item of page.items) expect(item.remittanceDocumentId).toBeNull();
    expect(page.next_cursor).toBeNull();

    const one = await api.request({ method: "GET", as: s.human, path: `${path()}?limit=1` });
    expect(((await one.json()) as { next_cursor: string | null }).next_cursor).toBeNull();
  });

  it("400s an unknown filter and a hand-made cursor", async () => {
    for (const q of ["filter[status][eq]=draft", "cursor=bm90LWEtY3Vyc29y"]) {
      const res = await api.request({ method: "GET", as: s.human, path: `${path()}?${q}` });
      expect(res.status, q).toBe(400);
    }
  });

  it("reads one schedule, and 404s an id that is not one", async () => {
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}/${generated.scheduleId}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(generated);
    const missing = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}/00000000-0000-7000-8000-000000000000`,
    });
    expect(missing.status).toBe(404);
  });

  it("the CSV is the archived file: text/csv, the five generic columns, no authority, form or box", async () => {
    const res = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}/${generated.scheduleId}/csv`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe(
      "employee_number,employee_name,scheme_reference,employee_share,employer_share",
    );
    expect(
      lines
        .slice(1)
        .filter((l) => l.length > 0)
        .map((l) => l.split(",").slice(-2)),
    ).toEqual([
      ["50.0000", "100.0000"],
      ["50.0000", "100.0000"],
    ]);
    // Hazard 2 at the WIRE. The fixture's scheme code reaches only the file NAME, never the body.
    expect(text).not.toMatch(/LHDN|EPF|KWSP|SOCSO|PERKESO|EIS|PCB|CP\d|borang/i);
    expect(res.headers.get("content-disposition")).not.toMatch(/LHDN|KWSP|PERKESO|borang/i);

    // …and byte-identical to the attachment 2C serves under the run (module hr → hr.payroll.read).
    const archived = await api.request({
      method: "GET",
      as: s.human,
      path: `/v1/companies/${s.company}/attachments/${generated.attachmentId}/content`,
    });
    expect(archived.status).toBe(200);
    expect(await archived.text()).toBe(text);
  });

  it("403s a read without hr.payroll.read", async () => {
    const res = await api.request({ method: "GET", as: f.payer, path: `${path()}?limit=1` });
    expect(res.status).toBe(403);
    const csv = await api.request({
      method: "GET",
      as: f.payer,
      path: `${path()}/${generated.scheduleId}/csv`,
    });
    expect(csv.status).toBe(403);
  });
});

describe("POST /v1/companies/{companyId}/statutory-schedules/{scheduleId}/settle (8C T8)", () => {
  const settlePath = () => `${path()}/${generated.scheduleId}/settle`;

  it("403s a principal without hr.payroll.pay", async () => {
    const res = await api.request({
      method: "POST",
      path: settlePath(),
      as: f.payer,
      body: { remittanceDocumentId: f.payrollDocumentId },
    });
    expect(res.status).toBe(403);
  });

  it("422s ERR_PAYROLL_REMITTANCE_MISMATCH for a payment of a different amount — the 0091 trigger's token", async () => {
    const wrong = await postRemittance(api.db, s, f, { amount: "300.0100" });
    const res = await api.request({
      method: "POST",
      path: settlePath(),
      as: s.human,
      body: { remittanceDocumentId: wrong },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_PAYROLL_REMITTANCE_MISMATCH");
    expect(problem.detail).toMatch(/settles 300\.0000, payment .* moves 300\.0100/);
  });

  it("400s a document that is not a PAYMENT, and 404s one that does not exist", async () => {
    const run = await api.request({
      method: "POST",
      path: settlePath(),
      as: s.human,
      body: { remittanceDocumentId: f.payrollDocumentId },
    });
    expect(run.status).toBe(400);
    expect((await problemOf(run)).code).toBe("ERR_VALIDATION_FAILED");
    const none = await api.request({
      method: "POST",
      path: settlePath(),
      as: s.human,
      body: { remittanceDocumentId: "00000000-0000-7000-8000-000000000000" },
    });
    expect(none.status).toBe(404);
  });

  it("200s the right payment, the list then reports it settled, and a second settle is 400", async () => {
    const right = await postRemittance(api.db, s, f, { amount: "300.0000" });
    const res = await api.request({
      method: "POST",
      path: settlePath(),
      as: s.human,
      body: { remittanceDocumentId: right },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Schedule).remittanceDocumentId).toBe(right);

    const settled = await api.request({
      method: "GET",
      as: s.human,
      path: `${path()}?filter[settled][eq]=true`,
    });
    const page = (await settled.json()) as { items: Schedule[] };
    expect(page.items.map((i) => i.remittanceDocumentId)).toEqual([right]);

    const again = await api.request({
      method: "POST",
      path: settlePath(),
      as: s.human,
      body: { remittanceDocumentId: right },
    });
    expect(again.status).toBe(400);
    expect((await problemOf(again)).detail).toMatch(/already settled by payment/);
  });
});
