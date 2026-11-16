import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  grantCodes,
  seedDocumentType,
  seedReportDefinition,
  seedTenantV2,
  type Seed,
} from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";
import { pdfText } from "../../../../../tests/support/pdf";
import { problemOf } from "../../../../../tests/support/api";
import { PAYROLL_PACK_ROOT, secondApprover } from "../../../../../tests/invariants/support/payroll";
import {
  hrReportFixture,
  readHrEnvelope,
  type HrReportFixture,
} from "../../../../../tests/invariants/support/hr-reports";

// 8D T5 — POST …/payroll-runs/{documentId}/payslips over HTTP (spec:2083; amendments A4, A5, A11). Acceptance test 33
// (payslips identical across runs, at the rendered-text layer through `pdfText`, never the bytes — §4.5.9) and test 23
// (both text directions) re-run here. SYNTH figures (hazard 1): per employee gross 2000.0000, net 1950.0000.

type Payslip = {
  attachmentId: string;
  employeeId: string;
  employeeNumber: string;
  fileName: string;
  byteSize: number;
  sha256: string;
};

let api: StartedApi;
let s: Seed;
let f: HrReportFixture;
let officer: string;
let readerOnly: string;
let filerOnly: string;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "payslips");
  // 8B's payroll corpus through 8D's fixture: one POSTED January run, a February DRAFT run, two employees.
  f = await hrReportFixture(api.db, s);
  // `s.human` holds hr.payroll.prepare and hr.payroll.read from the fixture; the route's own code is granted here.
  await grantCodes(api.db, s, { codes: ["hr.filing.generate"] });
  officer = s.human;
  // Holds the definition's read code but NOT the route's: refused at the route gate.
  readerOnly = await secondApprover(api.db, s, ["hr.payroll.read"]);
  // Holds the route's code but NOT the definition's read code: refused when the definition is resolved.
  filerOnly = await secondApprover(api.db, s, ["hr.filing.generate"]);
  await api.loadPrincipals();
}, 300_000);
afterAll(async () => {
  await api.stop();
});

const path = (documentId = f.runDocumentId) =>
  `/v1/companies/${s.company}/payroll-runs/${documentId}/payslips`;
const generate = async (body: Record<string, unknown>, idempotencyKey?: string) =>
  api.request({
    method: "POST",
    path: path(),
    as: officer,
    body,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
const content = async (attachmentId: string): Promise<Uint8Array> => {
  const res = await api.request({
    method: "GET",
    as: officer,
    path: `/v1/companies/${s.company}/attachments/${attachmentId}/content`,
  });
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
};
/** Every dash and Private Use mark removed — see the employee-number case for why. */
const dehyphen = (v: string): string => v.replace(/[-\u00ad\u2010-\u2015\u2212\ue000-\uf8ff]/g, "");
/** The distinct money figures a PDF's text states. */
const amounts = (t: string): string[] =>
  [...new Set(t.match(/\d[\d,]*\.\d{2}(?!\d)/g) ?? [])].toSorted();
const textOf = async (attachmentId: string): Promise<string> =>
  (await pdfText(await content(attachmentId))).join("\n");

describe("POST /v1/companies/{companyId}/payroll-runs/{documentId}/payslips", () => {
  it("404s naming hr.payslip until the report pack is applied to the company", async () => {
    const res = await generate({ lang: "en" });
    expect(res.status).toBe(404);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_NOT_FOUND");
    expect(problem.detail).toContain("hr.payslip");
    // The pack file itself, as `bun run seed --only reports` would apply it.
    await seedReportDefinition(api.db, s, {
      code: "hr.payslip",
      definition: readHrEnvelope("hr.payslip").definition,
    });
  });

  it("produces one attachment per employee ON THE RUN, each with its own sha256 over the stored bytes", async () => {
    const res = await generate({ lang: "en" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: Payslip[]; next_cursor: string | null };
    expect(body.next_cursor).toBeNull();
    expect(body.items.map((i) => i.employeeId)).toEqual([
      f.payroll.employeeAId,
      f.payroll.employeeBId,
    ]);
    expect(new Set(body.items.map((i) => i.sha256)).size).toBe(body.items.length);
    for (const i of body.items) {
      expect(i.fileName).toBe(`payslip-${i.employeeNumber}-${f.periodEnd}-en.pdf`);
      expect(i.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(i.byteSize).toBeGreaterThan(0);
      // The stored bytes are THERE, they are a PDF, and they are the bytes the hash names.
      const bytes = await content(i.attachmentId);
      expect(bytes.byteLength).toBe(i.byteSize);
      expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(i.sha256);
    }
    const rows = await api.db.admin<{ document_id: string; mime_type: string }[]>`
      select document_id, mime_type from app.attachment where id = any(${body.items.map((i) => i.attachmentId)}::uuid[])`;
    expect(rows.map((r) => r.document_id)).toEqual([f.runDocumentId, f.runDocumentId]);
    expect(rows.every((r) => r.mime_type === "application/pdf")).toBe(true);
  });

  it("the PDF states the employee's own figures — the payslip's total is their net", async () => {
    const res = await generate({ lang: "en", employeeIds: [f.payroll.employeeAId] });
    expect(res.status).toBe(201);
    const { items } = (await res.json()) as { items: Payslip[] };
    expect(items).toHaveLength(1);
    const text = await textOf(items[0]!.attachmentId);
    expect(text).toContain("Payslip");
    // Hyphen-insensitive: under this container's Chromium the hyphen-minus (and the em dash) reach the text layer as
    // Private Use code points (U+E088, U+E08B) — test 15's known failure, `CR1` for `CR-1` — so `E-0001` does not read
    // back as written here and does on a correct build. Both sides are compared with every dash and PUA mark removed.
    expect(dehyphen(text)).toContain(dehyphen(items[0]!.employeeNumber));
    expect(text).toContain("Amount");
    expect(text).toContain("1,950.00"); // net, both as the total row and in the footer
    expect(text).toContain("2,000.00"); // gross
  });

  it("test 33 — the rendered TEXT is identical across two generations of the same posted run", async () => {
    const a = (await (await generate({ lang: "en" })).json()) as { items: Payslip[] };
    const b = (await (await generate({ lang: "en" })).json()) as { items: Payslip[] };
    // Each generation writes NEW rows: an earlier payslip's hash is never overwritten (spec:2049).
    expect(b.items.map((i) => i.attachmentId)).not.toEqual(a.items.map((i) => i.attachmentId));
    for (let i = 0; i < a.items.length; i += 1) {
      // Byte identity is NOT asserted: Chromium embeds a creation date (§4.5.9). The rendered-text layer is where
      // determinism is pinned, and where a formula change would show.
      expect(await textOf(b.items[i]!.attachmentId)).toBe(await textOf(a.items[i]!.attachmentId));
    }
  });

  it("test 23 — the Arabic payslip renders its own labels, right to left, with the same figures", async () => {
    const en = (await (await generate({ lang: "en" })).json()) as { items: Payslip[] };
    const ar = (await (await generate({ lang: "ar" })).json()) as { items: Payslip[] };
    expect(ar.items[0]!.fileName).toMatch(/-ar\.pdf$/);
    const e = await textOf(en.items[0]!.attachmentId);
    const a = await textOf(ar.items[0]!.attachmentId);
    expect(e).toContain("Amount");
    expect(a).toContain("المبلغ");
    expect(a).toContain("قسيمة الراتب");
    expect(a).not.toContain("Amount");
    // §3.2 stores one figure and the renderer localises the LABELS: the same money figures appear in both. Compared as
    // a SET: the one signed cell (an employee share's −50.00 to net) carries its sign as a hyphen-minus, which this
    // container's Chromium hands the text layer as a Private Use code point (test 15's known failure), and in an RTL
    // row that neutral-less glyph then splits the cell's digits — an extraction artefact, recorded in the phase-8
    // progress log; the figure itself is asserted in packages/db/test/hr/payslip.test.ts.
    expect(amounts(e)).toEqual(["0.00", "1,950.00", "100.00", "2,000.00", "50.00"]);
    // The zero cell is left out of the Arabic comparison: in an RTL row some Chromium builds' text layers split its
    // digits, while every non-zero figure survives whole (CI's Chromium, PR #17).
    const nonZero = (t: string): string[] => amounts(t).filter((v) => v !== "0.00");
    expect(nonZero(a)).toEqual(nonZero(e));
  });

  it("an unknown employee id yields an empty list, not an error", async () => {
    const res = await generate({ lang: "en", employeeIds: [f.contractorId] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { items: Payslip[] }).items).toEqual([]);
  });

  it("a principal without hr.filing.generate is refused at the route gate", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: readerOnly,
      body: { lang: "en" },
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("hr.filing.generate");
  });

  it("a principal without the definition's read code (hr.payroll.read) is refused too", async () => {
    const res = await api.request({
      method: "POST",
      path: path(),
      as: filerOnly,
      body: { lang: "en" },
    });
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("hr.payroll.read");
  });

  it("a draft run is refused with 409 ERR_DOC_STATUS_ILLEGAL naming the document", async () => {
    const res = await api.request({
      method: "POST",
      as: officer,
      body: { lang: "en" },
      path: path(f.draftRunDocumentId),
    });
    expect(res.status).toBe(409);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_DOC_STATUS_ILLEGAL");
    expect(problem.detail).toContain(f.draftRunDocumentId);
  });

  it("a run id this company does not hold is 404", async () => {
    const res = await api.request({
      method: "POST",
      as: officer,
      body: { lang: "en" },
      path: path(s.company), // a real uuid that is not a payroll run
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("400s an unknown body member and a missing Idempotency-Key", async () => {
    const bad = await generate({ lang: "en", surprise: true });
    expect(bad.status).toBe(400);
    expect((await problemOf(bad)).code).toBe("ERR_VALIDATION_FAILED");
    const noKey = await api.request({
      method: "POST",
      path: path(),
      as: officer,
      body: { lang: "en" },
      idempotencyKey: null,
    });
    expect(noKey.status).toBe(400);
    expect((await problemOf(noKey)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("replaying the SAME Idempotency-Key returns the stored body, not a second set of attachments", async () => {
    const key = crypto.randomUUID();
    const first = await generate({ lang: "en" }, key);
    expect(first.status).toBe(201);
    const [before] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.attachment where document_id = ${f.runDocumentId}`;
    const second = await generate({ lang: "en" }, key);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    const [after] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.attachment where document_id = ${f.runDocumentId}`;
    expect(after!.n).toBe(before!.n);
  });

  it("holds no pooled connection idle in a transaction while it renders and stores the PDFs (CON-02)", async () => {
    // The route ran inside the idempotency middleware's request-spanning transaction, so one of the API's
    // four pooled connections sat `idle in transaction` through every Chromium render and object PUT. A
    // PUT happens between renders; every app_rw backend is looked at from there.
    const store = api.objectStore;
    const put = store.put.bind(store);
    const seen: string[] = [];
    store.put = async (key, bytes, contentType) => {
      const rows = await api.db.admin<{ state: string }[]>`
        select state from pg_stat_activity
         where usename = 'app_rw' and state like 'idle in transaction%'`;
      seen.push(...rows.map((r) => r.state));
      return put(key, bytes, contentType);
    };
    try {
      const res = await generate({ lang: "en" }, `payslips-con-02-${crypto.randomUUID()}`);
      expect(res.status).toBe(201);
      expect(((await res.json()) as { items: Payslip[] }).items).toHaveLength(2);
    } finally {
      store.put = put;
    }
    expect(seen).toEqual([]);
  });

  it("the generated OpenAPI document declares exactly the statuses this route can return", () => {
    const doc = api.app.getOpenAPIDocument({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
    }) as { paths?: Record<string, { post?: { responses?: Record<string, unknown> } }> };
    const op = doc.paths?.["/v1/companies/{companyId}/payroll-runs/{documentId}/payslips"]?.post;
    expect(Object.keys(op?.responses ?? {}).toSorted()).toEqual([
      "201",
      "400",
      "403",
      "404",
      "409",
      "422",
    ]);
  });
});

/**
 * Phase 8 review (2026-11-08): the earlier generations are LISTABLE by the payroll role. 2C's list gate asked
 * `accounting.ledger.read` whatever the named document, so the seeded `hr_payroll` shape — `hr.payroll.read` without the
 * ledger code — could download a payslip it was handed but never list the run's payslips. A list that names a document
 * now asks that document's module read code (§4.5.8's one map) at its branch, as the download gate already did.
 */
describe("GET /v1/companies/{companyId}/attachments?documentId={run} — the run's earlier payslips", () => {
  const list = (as: string, documentId = f.runDocumentId) =>
    api.request({
      method: "GET",
      as,
      path: `/v1/companies/${s.company}/attachments?documentId=${documentId}`,
    });

  it("a holder of hr.payroll.read alone lists every payslip generated on the run", async () => {
    const res = await list(readerOnly);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { documentId: string; fileName: string }[] };
    // Every attachment of the run — the payslips of each generation, and the fixture's statutory schedule file.
    for (const item of body.items) expect(item.documentId).toBe(f.runDocumentId);
    const payslips = body.items.filter((item) => item.fileName.startsWith("payslip-"));
    expect(payslips.length).toBeGreaterThanOrEqual(2);
  });

  it("a holder of accounting.ledger.read without hr.payroll.read is refused the run's list, naming the hr code", async () => {
    const accountant = await secondApprover(api.db, s, ["accounting.ledger.read"]);
    await api.loadPrincipals();
    const res = await list(accountant);
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("hr.payroll.read");
  });

  it("a holder of hr.payroll.read is still refused the company-wide list, which asks the ledger code", async () => {
    const res = await api.request({
      method: "GET",
      as: readerOnly,
      path: `/v1/companies/${s.company}/attachments`,
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).detail).toContain("accounting.ledger.read");
  });
});

/**
 * Phase 8 review (2026-11-08), test 32's endpoint channel for the payroll documents: `GET …/documents/{id}` was gated
 * on the three accounting read codes alone, so a clerk holding `accounting.journal.create` read a posted PAYROLL's
 * per-employee lines — the figures `payroll_line` and the payslip route keep behind `hr.payroll.read`. An `hr`
 * document's read now also asks that code at the document's branch (§4.5.8's `hr` row), as its print and events do.
 */
describe("GET /v1/companies/{companyId}/documents/{run} — a payroll document needs hr.payroll.read", () => {
  const read = (as: string) =>
    api.request({
      method: "GET",
      as,
      path: `/v1/companies/${s.company}/documents/${f.runDocumentId}`,
    });

  it("a ledger reader without hr.payroll.read is refused, naming the code", async () => {
    const clerk = await secondApprover(api.db, s, [
      "accounting.journal.create",
      "accounting.ledger.read",
    ]);
    await api.loadPrincipals();
    const res = await read(clerk);
    expect(res.status).toBe(403);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_RBAC_FORBIDDEN");
    expect(problem.detail).toContain("hr.payroll.read");
  });

  it("a ledger reader who also holds hr.payroll.read reads the run with its lines", async () => {
    const both = await secondApprover(api.db, s, ["accounting.ledger.read", "hr.payroll.read"]);
    await api.loadPrincipals();
    const res = await read(both);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { lines: unknown[] }).lines.length).toBeGreaterThan(0);
  });
});

/**
 * Phase 8 review (2026-11-08): a PAYROLL is written by its run service only. The generic `POST …/documents` and
 * `PUT …/documents/{id}/lines` resolve their gate from the PAYROLL policy (`hr.payroll.prepare`), so the preparer could
 * replace a draft run's calculated lines with hand-keyed ones — which carry no `payroll_line`, so the approval screen
 * (`GET …/payroll-runs/{id}`, read through `payroll_line`) never shows them, and R1's second person approves what they
 * cannot see; `employee_ytd` then misses them too. FX_REVALUATION's precedent: refused as service-only.
 */
describe("the generic document routes refuse the three hr types — their services write them", () => {
  beforeAll(async () => {
    // The two money-out types from the SHIPPED pack files (8C's moneyOutFixture does the same), and their create codes
    // on the officer, so the policy-resolved gate admits the draft and the refusal is the handler's.
    for (const code of ["PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"] as const) {
      const envelope = JSON.parse(
        readFileSync(join(PAYROLL_PACK_ROOT, `document-types/${code}.json`), "utf8"),
      ) as { module: "hr"; policy: unknown };
      await seedDocumentType(api.db, s, { code, module: envelope.module, policy: envelope.policy });
    }
    await grantCodes(api.db, s, { codes: ["hr.payroll.pay", "hr.advance.create"] });
    await api.loadPrincipals();
  });

  it("PUT …/documents/{run}/lines on a draft PAYROLL is refused, and the run's lines are untouched", async () => {
    const before = await api.db.admin<{ n: string }[]>`
      select count(*)::text as n from app.document_line where document_id = ${f.draftRunDocumentId}`;
    const [account] = await api.db.admin<{ id: string }[]>`
      select id from app.account where company_id = ${s.company} and code = '2400'`;
    const res = await api.request({
      method: "PUT",
      as: officer,
      path: `/v1/companies/${s.company}/documents/${f.draftRunDocumentId}/lines`,
      body: {
        lines: [
          { lineNo: 1, accountId: account!.id, debit: "1.0000" },
          { lineNo: 2, accountId: account!.id, credit: "1.0000" },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toContain("PAYROLL");
    const after = await api.db.admin<{ n: string }[]>`
      select count(*)::text as n from app.document_line where document_id = ${f.draftRunDocumentId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it.each(["PAYROLL", "PAYROLL_PAYMENT", "EMPLOYEE_ADVANCE"])(
    "POST …/documents drafting a %s by hand is refused",
    async (code) => {
      const [account] = await api.db.admin<{ id: string }[]>`
        select id from app.account where company_id = ${s.company} and code = '2400'`;
      const res = await api.request({
        method: "POST",
        as: officer,
        path: `/v1/companies/${s.company}/documents`,
        body: {
          documentTypeCode: code,
          effectiveDate: "2026-01-31",
          currency: "MYR",
          branchId: s.hq,
          lines: [
            { lineNo: 1, accountId: account!.id, debit: "1.0000" },
            { lineNo: 2, accountId: account!.id, credit: "1.0000" },
          ],
        },
      });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).detail).toContain(code);
    },
  );
});
