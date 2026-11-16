import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS, isMutating } from "@dulja/contracts";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "@dulja/db/test";
import { ROLES } from "@dulja/db/seed/roles";
import { problemOf } from "../../../../../tests/support/api";
import {
  postInventoryDocument,
  recordingJobs,
  secondPrincipal,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

/**
 * The catalogue half, deliberately a SIBLING of the route describe below rather than a member of it:
 * nothing here touches Postgres, so it runs where no Docker daemon does. The same shape
 * `packages/db/test/permission-catalogue.test.ts` uses for its 3A block.
 */
describe("the permission code slice 3B introduces (contracts §3.6.2)", () => {
  it("inventory.cost.read is in the catalogue exactly once, non-mutating, phase 3B", () => {
    const rows = PERMISSIONS.filter((permission) => permission.code === "inventory.cost.read");
    // `toMatchObject` on the three fields this case is about, never `toEqual` on a partial row:
    // `PermissionDef` has five required members (§4.2.5), so a `toEqual` against three of them could only
    // pass against a malformed entry.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ module: "inventory", mutating: false, phase: "3B" });
  });

  it("is non-mutating, which is what lets the auditor hold it (R7, spec:2178)", () => {
    expect(isMutating("inventory.cost.read")).toBe(false);
  });

  it("is the only 3B code — the slice introduces exactly one", () => {
    expect(
      PERMISSIONS.filter((permission) => permission.phase === "3B").map((p) => p.code),
    ).toEqual(["inventory.cost.read"]);
  });
});

describe("GET /v1/companies/{companyId}/valuation (inventory.cost.read; amendment A8)", () => {
  let api: StartedApi;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;

  /** §4.2.12: one `ApiRequest` object; `as` names the principal. A GET with no `as` is unauthenticated and
   *  answers 401, so every read below names one. */
  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Valuation");
    await grantCodes(api.db, s, {
      codes: ["inventory.cost.read", "accounting.journal.post"],
      roleCode: "cost-reader",
    });
    const receipt = await seedDocumentType(api.db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    const issue = await seedDocumentType(api.db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1) and `evaluatePolicy` refuses a receipt of a
    // lot-tracked item whose line names no lot (ERR_POLICY_REQUIRES_MISSING); this suite's lines name none.
    ({ itemId } = await seedItem(api.db, s, { code: "VAL-1", trackLots: false }));
    warehouseId = await seedWarehouse(api.db, s, { code: "V-WH" });
    // `recordingJobs()` because `postDocument`'s step 14 wants a `JobClient` (amendment A5) and the API's
    // own client throws by design in route tests.
    for (const post of [
      { typeId: receipt, effectiveDate: "2026-01-10", quantity: "100.000000", price: "10.0000" },
      { typeId: receipt, effectiveDate: "2026-02-10", quantity: "100.000000", price: "20.0000" },
      { typeId: issue, effectiveDate: "2026-02-20", quantity: "50.000000", price: "40.0000" },
    ]) {
      await postInventoryDocument(api.db, s, {
        documentTypeId: post.typeId,
        warehouseId,
        effectiveDate: post.effectiveDate,
        jobs: recordingJobs(),
        lines: [{ itemId, warehouseId, quantity: post.quantity, unitPrice: post.price }],
      });
    }
  }, 180_000);

  afterAll(async () => {
    await api.stop();
  });

  it("as at 2026-01-31 only the January layer exists — 100 at 10.0000", async () => {
    const res = await get(`/v1/companies/${s.company}/valuation?asOf=2026-01-31`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, string>[] };
    expect(body.items).toEqual([
      {
        itemId,
        itemCode: "VAL-1",
        itemNameEn: expect.any(String),
        warehouseId,
        warehouseCode: "V-WH",
        quantity: "100.000000",
        value: "1000.0000",
        unitCost: "10.0000",
      },
    ]);
  });

  it("as at 2026-02-28 the issue has consumed proportionally — 150 at the 15.0000 average", async () => {
    const res = await get(`/v1/companies/${s.company}/valuation?asOf=2026-02-28`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, string>[] };
    // AVCO took 25 from each layer at 15.0000: 75 × 10 + 75 × 20 = 2250.0000 over 150.000000.
    expect(body.items[0]?.quantity).toBe("150.000000");
    expect(body.items[0]?.value).toBe("2250.0000");
    expect(body.items[0]?.unitCost).toBe("15.0000");
  });

  it("the as-of date is on effective_date, not posted_at — the February receipt is invisible in January", async () => {
    // Every document above was POSTED in this one `beforeAll`, within seconds of each other, so a read that
    // filtered on `posted_at` would answer the same figure for both dates (spec:2039).
    const january = (await (
      await get(`/v1/companies/${s.company}/valuation?asOf=2026-01-31`)
    ).json()) as { items: { quantity: string }[] };
    const february = (await (
      await get(`/v1/companies/${s.company}/valuation?asOf=2026-02-28`)
    ).json()) as { items: { quantity: string }[] };
    expect(january.items[0]?.quantity).not.toBe(february.items[0]?.quantity);
  });

  it("…/valuation/layers returns the open layers oldest first with their residues", async () => {
    const res = await get(
      `/v1/companies/${s.company}/valuation/layers?asOf=2026-02-28&filter[item_id][eq]=${itemId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        effectiveAt: string;
        qtyRemaining: string;
        unitCost: string;
        value: string;
        documentTypeCode: string;
        lotCode: string;
      }[];
    };
    expect(
      body.items.map((row) => [row.effectiveAt, row.qtyRemaining, row.unitCost, row.value]),
    ).toEqual([
      ["2026-01-10", "75.000000", "10.0000", "750.0000"],
      ["2026-02-10", "75.000000", "20.0000", "1500.0000"],
    ]);
    expect(body.items[0]?.documentTypeCode).toBe("STOCK_RECEIPT_TEST");
    expect(body.items[0]?.lotCode).toBe("NONE");
  });

  it("a principal without inventory.cost.read is refused with ERR_RBAC_FORBIDDEN", async () => {
    const other = await seedTenantV2(api.db, "NoRead");
    const res = await get(`/v1/companies/${other.company}/valuation?asOf=2026-02-28`, other.human);
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  /**
   * Code review 2, S1b. spec:2159 `warehouse` "May not: Prices, costs, …" and spec:2160 `branch_manager` "May
   * not: Prices, …; costs; …" — and spec:2163 fixes that "costs" means SIGHT of costs, by giving the auditor
   * "Read everything financial: … stock and costs". `inventory.cost.read` is the catalogue's only cost code
   * (spec:2148), so neither seeded role may hold it. A principal granted EXACTLY the seeded role's codes,
   * company-wide (the strictest reading: no branch row narrows it), is refused every valuation read. Before
   * the fix the seed granted both roles the code and every read below answered 200.
   */
  for (const roleCode of ["warehouse", "branch_manager"] as const) {
    it(`a principal holding exactly the seeded ${roleCode} role is refused the valuation reads (S1b)`, async () => {
      const role = ROLES.find((candidate) => candidate.code === roleCode)!;
      const principal = await secondPrincipal(api.db, s, `valuation-${roleCode}`);
      await grantCodes(api.db, s, {
        codes: role.permissions,
        principalId: principal,
        roleCode: `valuation-seeded-${roleCode}`,
      });
      await api.loadPrincipals();
      for (const path of [
        `/v1/companies/${s.company}/valuation?asOf=2026-02-28`,
        `/v1/companies/${s.company}/valuation/layers?asOf=2026-02-28&filter[item_id][eq]=${itemId}`,
        `/v1/companies/${s.company}/reports/inventory.valuation?asOf=2026-02-28`,
      ]) {
        const res = await get(path, principal);
        expect(res.status, `${roleCode} ${path}`).toBe(403);
        expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
      }
    });
  }

  it("asOf is required — a missing one is a 400, not a silent 'today'", async () => {
    const res = await get(`/v1/companies/${s.company}/valuation`);
    // 400: §4.2.4 fixes ERR_VALIDATION_FAILED at 400, and every Zod query failure reaches the wire so.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("an unknown query key is refused rather than silently dropped (.strict(), §4.2.8)", async () => {
    const res = await get(
      `/v1/companies/${s.company}/valuation?asOf=2026-02-28&filter[item_code][eq]=VAL-1`,
    );
    // 400: §4.2.4 fixes ERR_VALIDATION_FAILED at 400, and every Zod query failure reaches the wire so.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("the layers route requires the item filter — layers are read one item at a time", async () => {
    const res = await get(`/v1/companies/${s.company}/valuation/layers?asOf=2026-02-28`);
    // 400: §4.2.4 fixes ERR_VALIDATION_FAILED at 400, and every Zod query failure reaches the wire so.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });
});
