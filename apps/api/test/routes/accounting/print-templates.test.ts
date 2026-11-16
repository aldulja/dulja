import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenantV2, type Seed } from "@dulja/db/test";
import { parseTemplateSource } from "@dulja/domain";
import { grantAdmin } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

const body = {
  documentTypeCode: "JOURNAL",
  code: "compact",
  version: 1,
  nameEn: "Compact voucher",
  nameAr: "قيد مختصر",
  engine: "chromium" as const,
  paper: "A5" as const,
  labels: { en: { total: "Total" }, ar: { total: "الإجمالي" } },
  body: "<p>{{ labels.total }} {{ totals.debit }}</p>",
};

describe("/v1/companies/{companyId}/print-templates — configuration, not code (test 15)", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    await grantAdmin(api, a);
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("creates a template and stores front matter plus body in one source column", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/print-templates`,
      as: a.human,
      body,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      code: string;
      version: number;
      source: string;
      paper: string;
    };
    expect(created).toMatchObject({ code: "compact", version: 1, paper: "A5" });
    const parsed = parseTemplateSource(created.source);
    expect(parsed.meta.labels.ar["total"]).toBe("الإجمالي");
    expect(parsed.body).toBe(body.body);
  });

  it("refuses a duplicate (type, code, version) with ERR_CONFLICT_UNIQUE", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/print-templates`,
      as: a.human,
      body,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("refuses an engine ADR 0016 does not name", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/print-templates`,
      as: a.human,
      body: { ...body, code: "bad", engine: "wkhtmltopdf" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a template body the renderer cannot parse — a broken template never reaches the table", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/print-templates`,
      as: a.human,
      body: { ...body, code: "broken", body: "{{#each lines}}oops" },
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("unclosed #each");
  });

  it("refuses an unknown document type with 404", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/print-templates`,
      as: a.human,
      body: { ...body, code: "orphan", documentTypeCode: "NOSUCH" },
    });
    expect(res.status).toBe(404);
  });

  it("requires admin.company.manage", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/print-templates`,
      as: b.human,
      body: { ...body, code: "nope" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("lists a company's templates", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/print-templates`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { items: { code: string }[]; next_cursor: string | null };
    expect(list.items.map((i) => i.code)).toContain("compact");
    expect(list.next_cursor).toBeNull();
  });
});
