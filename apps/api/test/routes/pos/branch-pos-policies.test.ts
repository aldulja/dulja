import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApi, type StartedApi } from "../../support/app";
import { seedTenant, seedBranch, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { encodeCursor } from "@dulja/contracts";
import { grantAdmin, problemOf } from "../../../../../tests/support/api";

let api: StartedApi;
let s: Seed;
let branch: string;

beforeAll(async () => {
  api = await startApi();
  s = await seedTenant(api.db, "pol");
  branch = await seedBranch(api.db, s, { code: "BR-API" });
  await grantAdmin(api, s);
  await api.loadPrincipals();
}, 180_000);
afterAll(async () => {
  await api.stop();
});

describe("PUT|GET /v1/companies/{companyId}/branch-pos-policies", () => {
  it("preserves omitted nullable limits and clears only explicit nulls", async () => {
    const branchId = await seedBranch(api.db, s, { code: "NULLABLE-POLICY" });
    const path = `/v1/companies/${s.company}/branch-pos-policies`;
    const saved = await api.request({
      method: "PUT",
      path,
      as: s.human,
      body: { branchId, maxCashInDrawer: "123.4567", requireCustomerOver: "99.0000" },
    });
    expect(saved.status).toBe(200);
    const unchanged = await api.request({
      method: "PUT",
      path,
      as: s.human,
      body: { branchId, maxVoidAmount: "5.0000" },
    });
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({
      maxCashInDrawer: "123.4567",
      requireCustomerOver: "99.0000",
    });
    const cleared = await api.request({
      method: "PUT",
      path,
      as: s.human,
      body: { branchId, maxCashInDrawer: null, requireCustomerOver: null },
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      maxCashInDrawer: null,
      requireCustomerOver: null,
    });
  });

  it("pages actual rows with the shared cursor and refuses malformed UUID keysets", async () => {
    const path = `/v1/companies/${s.company}/branch-pos-policies`;
    for (const code of ["PAGE-A", "PAGE-B"]) {
      const branchId = await seedBranch(api.db, s, { code });
      expect(
        (await api.request({ method: "PUT", path, as: s.human, body: { branchId } })).status,
      ).toBe(200);
    }
    const first = await api.request({ method: "GET", path: `${path}?limit=1`, as: s.human });
    expect(first.status).toBe(200);
    const page = (await first.json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    const second = await api.request({
      method: "GET",
      path: `${path}?limit=1&cursor=${page.next_cursor}`,
      as: s.human,
    });
    expect(second.status).toBe(200);
    const next = (await second.json()) as { items: { id: string }[] };
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    const invalid = await api.request({
      method: "GET",
      path: `${path}?cursor=${encodeCursor({ k: [], id: "not-uuid" })}`,
      as: s.human,
    });
    expect(invalid.status).toBe(400);
    expect((await problemOf(invalid)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses same-tenant branches belonging to another company or another dimension", async () => {
    const company = await uuidv7(api.db.admin),
      branchType = await uuidv7(api.db.admin),
      deptType = await uuidv7(api.db.admin);
    const foreignBranch = await uuidv7(api.db.admin),
      department = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.company(id,tenant_id,code,name,base_currency) values(${company},${s.tenant},'OTHER-POLICY','Other','MYR')`;
      await tx`insert into app.dimension_type(id,tenant_id,company_id,code,name_en) values(${branchType},${s.tenant},${company},'BRANCH','Branch'),(${deptType},${s.tenant},${s.company},'DEPT','Department')`;
      await tx`insert into app.dimension_value(id,tenant_id,dimension_type_id,code,name_en) values(${foreignBranch},${s.tenant},${branchType},'OTHER','Other'),(${department},${s.tenant},${deptType},'ADMIN','Admin')`;
    });
    for (const branchId of [foreignBranch, department]) {
      const response = await api.request({
        method: "PUT",
        path: `/v1/companies/${s.company}/branch-pos-policies`,
        as: s.human,
        body: { branchId },
      });
      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe("ERR_NOT_FOUND");
    }
  });

  it("refuses a zero rounding increment before writing", async () => {
    const response = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/branch-pos-policies`,
      as: s.human,
      body: { branchId: branch, roundingIncrement: "0.0000" },
    });
    expect(response.status).toBe(400);
    expect((await problemOf(response)).code).toBe("ERR_VALIDATION_FAILED");
  });
  it("creates the row, then edits the same row on a second PUT", async () => {
    const first = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/branch-pos-policies`,
      as: s.human,
      body: { branchId: branch, maxLineDiscountPct: "0.100000", maxVoidAmount: "50.0000" },
    });
    expect(first.status).toBe(200);
    const a = (await first.json()) as { id: string; maxLineDiscountPct: string; revision: string };
    expect(a.maxLineDiscountPct).toBe("0.100000");

    const second = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/branch-pos-policies`,
      as: s.human,
      body: { branchId: branch, maxVoidAmount: "75.0000" },
    });
    const b = (await second.json()) as {
      id: string;
      maxLineDiscountPct: string;
      maxVoidAmount: string;
      revision: string;
    };
    expect(b.id).toBe(a.id); // one row per branch
    expect(b.maxLineDiscountPct).toBe("0.100000"); // an omitted field keeps its value
    expect(b.maxVoidAmount).toBe("75.0000");
    expect(BigInt(b.revision)).toBeGreaterThan(BigInt(a.revision));
  });

  it("refuses an unsafe call with no Idempotency-Key (spec:2055)", async () => {
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/branch-pos-policies`,
      as: s.human,
      body: { branchId: branch },
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a percentage above 1.000000 fails Zod before it reaches the database", async () => {
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/branch-pos-policies`,
      as: s.human,
      body: { branchId: branch, maxTicketDiscountPct: "1.500000" },
    });
    expect(res.status).toBe(400);
    const p = await problemOf(res);
    expect(p.code).toBe("ERR_VALIDATION_FAILED");
    expect(p.errors?.[0]?.path).toContain("maxTicketDiscountPct");
  });

  it("a branch of another tenant is 404, never 403 (no cross-tenant existence oracle)", async () => {
    const other = await seedTenant(api.db, "pol-other");
    const foreign = await seedBranch(api.db, other, { code: "BR-X" });
    const res = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/branch-pos-policies`,
      as: s.human,
      body: { branchId: foreign },
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("a principal without admin.company.manage is 403", async () => {
    const plain = await seedTenant(api.db, "pol-plain");
    await api.loadPrincipals();
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${plain.company}/branch-pos-policies`,
      as: plain.human,
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
