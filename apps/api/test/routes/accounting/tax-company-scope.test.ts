import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedBranch, seedTaxCode, uuidv7 } from "@dulja/db/test";
import { taxFixture, type TaxFixture } from "../../../../../tests/invariants/support/tax";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let f: TaxFixture;
let sibling: string;
let codeId: string;
let regimeId: string;
let returnId: string;
let transmissionId: string;

beforeAll(async () => {
  api = await startApi();
  f = await taxFixture(api.db, "tax-company-scope");
  await grantCodes(api.db, f.s, { codes: ["accounting.tax.file"] });
  sibling = await uuidv7(api.db.admin);
  const branchType = await uuidv7(api.db.admin);
  const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "sibling-company-fixture" };
  await withTenant(api.db.rw, ctx, async (tx) => {
    await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${sibling}, ${f.s.tenant}, 'SIBLING', 'Sibling company', 'MYR')`;
    await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${branchType}, ${f.s.tenant}, ${sibling}, 'BRANCH', 'Sibling branches')`;
  });
  const seed = { ...f.s, company: sibling, branchType };
  await grantCodes(api.db, seed);
  const branchId = await seedBranch(api.db, seed, { code: "HQ", nameEn: "Sibling branch" });
  ({ taxCodeId: codeId, regimeId } = await seedTaxCode(api.db, seed, {
    code: "SYN-ZERO",
    kind: "zero",
    rate: "0.00000000",
  }));
  await withTenant(api.db.rw, ctx, async (tx) => {
    const [r] = await tx<
      { id: string }[]
    >`insert into app.tax_return (tenant_id, company_id, regime_id, period_start, period_end) values (${f.s.tenant}, ${sibling}, ${regimeId}, '2026-01-01', '2026-01-31') returning id`;
    returnId = r!.id;
    const [t] = await tx<
      { id: string }[]
    >`insert into app.document_type (tenant_id, company_id, code, name_en, module) values (${f.s.tenant}, ${sibling}, 'SIBLING', 'Sibling type', 'accounting') returning id`;
    const [d] = await tx<
      { id: string }[]
    >`insert into app.document (tenant_id, company_id, document_type_id, status, series, effective_date, currency, branch_id) values (${f.s.tenant}, ${sibling}, ${t!.id}, 'draft', 'SIB', '2026-01-01', 'MYR', ${branchId}) returning id`;
    const [e] = await tx<
      { id: string }[]
    >`insert into app.einvoice_transmission (tenant_id, company_id, document_id, transmitter) values (${f.s.tenant}, ${sibling}, ${d!.id}, 'synthetic') returning id`;
    transmissionId = e!.id;
  });
  await api.loadPrincipals();
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const path = (resource: string) => `/v1/companies/${f.s.company}/${resource}`;

describe("Phase 5 IDs remain bound to the path company within one tenant", () => {
  it("refuses a sibling company's tax code read and archive", async () => {
    for (const request of [
      { method: "GET", suffix: "" },
      { method: "POST", suffix: "/archive" },
    ] as const) {
      const response = await api.request({
        method: request.method,
        path: path(`tax-codes/${codeId}${request.suffix}`),
        as: f.s.human,
      });
      expect(response.status).toBe(404);
    }
    const [row] = await api.db.admin<
      { archived_at: string | null }[]
    >`select archived_at from app.tax_code where id = ${codeId}`;
    expect(row!.archived_at).toBeNull();
  });

  it("refuses a sibling company's regime when creating a tax code", async () => {
    const response = await api.request({
      method: "POST",
      path: path("tax-codes"),
      as: f.s.human,
      body: {
        regimeId,
        code: "SYN-FOREIGN",
        nameEn: "Foreign regime",
        kind: "zero",
        rate: "0.00000000",
        accountCode: null,
        effectiveFrom: "2026-01-01",
      },
    });
    expect(response.status).toBe(404);
  });

  it("refuses reads, generation and filing of a sibling company's return", async () => {
    for (const request of [
      { method: "GET", suffix: "" },
      { method: "POST", suffix: "/generate" },
      { method: "POST", suffix: "/file" },
    ] as const) {
      const response = await api.request({
        method: request.method,
        path: path(`tax-returns/${returnId}${request.suffix}`),
        as: f.s.human,
        ...(request.suffix === "/file" ? { body: {} } : {}),
      });
      expect(response.status).toBe(404);
    }
    const [row] = await api.db.admin<
      { status: string }[]
    >`select status from app.tax_return where id = ${returnId}`;
    expect(row!.status).toBe("draft");
  });

  it("answers a sibling company's return and code exactly as it answers an id that does not exist", async () => {
    // The company is part of each service's own statement (PR 11 review, round 3), so a real id under
    // the wrong company and an unknown id reach one refusal: same status, same code, same detail up to
    // the id. A detail that differed would tell a caller of this company that the row exists elsewhere.
    const unknown = await uuidv7(api.db.admin);
    const answer = async (method: "GET" | "POST", resource: string, id: string, suffix: string) => {
      const response = await api.request({
        method,
        path: path(`${resource}/${id}${suffix}`),
        as: f.s.human,
        ...(suffix === "/file" ? { body: {} } : {}),
      });
      const problem = (await response.json()) as { code: string; detail: string };
      return {
        status: response.status,
        code: problem.code,
        detail: problem.detail.replace(id, "<id>"),
      };
    };
    for (const [method, resource, real, suffix] of [
      ["GET", "tax-returns", returnId, ""],
      ["POST", "tax-returns", returnId, "/generate"],
      ["POST", "tax-returns", returnId, "/file"],
      ["POST", "tax-codes", codeId, "/archive"],
    ] as const) {
      const sib = await answer(method, resource, real, suffix);
      expect(sib, `${method} ${resource}${suffix}`).toEqual(
        await answer(method, resource, unknown, suffix),
      );
      expect(sib.status, `${method} ${resource}${suffix}`).toBe(404);
    }
  });

  it("refuses reads, submission, cancellation and polling of a sibling company's transmission", async () => {
    // The sibling row is `pending`, which is illegal for cancel and poll: a 404 rather than a 409 is
    // what shows the company is checked before the status (inside the services' claim since ADR
    // 0053's 2026-10-06 amendment — the cancel and poll routes no longer pre-read the row).
    for (const request of [
      { method: "GET", suffix: "" },
      { method: "POST", suffix: "/submit" },
      { method: "POST", suffix: "/cancel" },
      { method: "POST", suffix: "/poll" },
    ] as const) {
      const response = await api.request({
        method: request.method,
        path: path(`einvoice-transmissions/${transmissionId}${request.suffix}`),
        as: f.s.human,
        ...(request.suffix === "/cancel" ? { body: { reason: "Wrong company" } } : {}),
      });
      expect(response.status).toBe(404);
    }
    const [row] = await api.db.admin<
      { status: string; attempts: number }[]
    >`select status, attempts from app.einvoice_transmission where id = ${transmissionId}`;
    expect(row).toEqual({ status: "pending", attempts: 0 });
  });
});
