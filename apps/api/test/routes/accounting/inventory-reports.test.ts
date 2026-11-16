import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeCursor,
  ReportCodeSchema,
  SalesByItemList,
  StockOnHandReportList,
  ValuationList,
} from "@dulja/contracts";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "@dulja/db/test";
import { DocumentSchema } from "@dulja/contracts/accounting/document";
import { ROLES } from "@dulja/db/seed/roles";
import { problemOf } from "../../../../../tests/support/api";
import { postArDocument } from "../../../../../tests/invariants/support/post-ar";
import {
  postInventoryDocument,
  recordingJobs,
  secondPrincipal,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../../tests/invariants/support/post-inventory";
import { ROUTES } from "../../../src/routes";
import { startApi, type StartedApi } from "../../support/app";

/**
 * The three §4.16.1 inventory report codes, mounted by 3D T10 as GETs on 1B's `reports` module.
 *
 * The cross-code case at the end is container-free and deliberately a SIBLING describe, so it runs where no
 * Docker daemon does — the same shape `apps/api/test/routes/inventory/valuation.test.ts` uses for its
 * permission-catalogue half.
 */
describe("the three inventory report codes on /v1/companies/{companyId}/reports", () => {
  let api: StartedApi;
  let s: Seed;
  let itemId: string;
  let warehouseId: string;

  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "InventoryReports");
    // `grantAdmin` grants only the five admin.* codes, so a suite whose gate resolves an inventory.* code
    // needs `grantCodes` as well or its own 200 cases answer 403.
    await grantCodes(api.db, s, {
      codes: ["inventory.stock.read", "inventory.cost.read", "accounting.journal.post"],
      roleCode: "inventory-report-reader",
    });
    const receipt = await seedDocumentType(api.db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1) and `evaluatePolicy` refuses a receipt of a
    // lot-tracked item whose line names no lot (ERR_POLICY_REQUIRES_MISSING); this suite's lines name none.
    ({ itemId } = await seedItem(api.db, s, { code: "RPT-1", trackLots: false }));
    warehouseId = await seedWarehouse(api.db, s, { code: "R-WH" });
    await postInventoryDocument(api.db, s, {
      documentTypeId: receipt,
      warehouseId,
      effectiveDate: "2026-01-10",
      jobs: recordingJobs(),
      lines: [{ itemId, warehouseId, quantity: "40.000000", unitPrice: "2.5000" }],
    });
  }, 180_000);

  afterAll(async () => {
    await api?.stop();
  });

  it("inventory.stock_on_hand answers a list whose every row validates, with the warehouse kind", async () => {
    const res = await get(`/v1/companies/${s.company}/reports/inventory.stock_on_hand`);
    expect(res.status).toBe(200);
    const body = StockOnHandReportList.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      itemId,
      itemCode: "RPT-1",
      warehouseId,
      warehouseCode: "R-WH",
      warehouseKind: "stock",
      lotCode: "NONE",
      quantity: "40.000000",
    });
    expect(body.next_cursor).toBeNull();
  });

  it("inventory.valuation answers 3B's own row type — this slice declares no second one", async () => {
    const res = await get(`/v1/companies/${s.company}/reports/inventory.valuation?asOf=2026-12-31`);
    expect(res.status).toBe(200);
    const body = ValuationList.parse(await res.json());
    expect(body.items[0]).toMatchObject({
      itemId,
      warehouseId,
      quantity: "40.000000",
      value: "100.0000",
      unitCost: "2.5000",
    });
  });

  it("inventory.sales_by_item answers an empty list when nothing has been delivered", async () => {
    // A STOCK_RECEIPT is not a DELIVERY_ORDER, so the report is empty rather than reporting the receipt as
    // a sale — the join is on document_type.code, never on the sign of the movement alone.
    const res = await get(
      `/v1/companies/${s.company}/reports/inventory.sales_by_item?fromDate=2026-01-01&toDate=2026-12-31`,
    );
    expect(res.status).toBe(200);
    expect(SalesByItemList.parse(await res.json()).items).toEqual([]);
  });

  it("inventory.sales_by_item carries 4A's revenue and margin as base-currency money beside 3D's two members", async () => {
    // Its own tenant, so the empty-list case above stays empty. The type is the SEEDED SALES_INVOICE file —
    // the report matches on document_type.code — and the item is a service, so the invoice posts revenue with
    // no delivery and no cost legs: the row exists for its revenue alone (the full join, 4A Task 11).
    const t = await seedTenantV2(api.db, "SalesByItemWire");
    // `inventory.cost.read` as well (code review 2, S1): without it the route withholds cost and margin,
    // and this case pins the wire shape of all three money members.
    await grantCodes(api.db, t, {
      codes: ["inventory.stock.read", "inventory.cost.read"],
      roleCode: "sales-by-item-reader",
    });
    const pack = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../packages/db/seed/my/document-types/SALES_INVOICE.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { code: string; policy: unknown };
    const invoiceType = await seedDocumentType(api.db, t, { code: pack.code, policy: pack.policy });
    const partyId = await seedParty(api.db, t, { code: "CUST-WIRE" });
    const { itemId: serviceId } = await seedItem(api.db, t, {
      code: "RPT-SV",
      kind: "service",
      trackLots: false,
    });
    await postArDocument(api.db, t, {
      documentTypeId: invoiceType,
      series: "INV",
      partyId,
      effectiveDate: "2026-01-12",
      lines: [
        {
          kind: "item",
          itemId: serviceId,
          quantity: "1.000000",
          unitPrice: "50.0000",
          amount: "50.0000",
        },
      ],
    });
    const res = await get(
      `/v1/companies/${t.company}/reports/inventory.sales_by_item?fromDate=2026-01-01&toDate=2026-01-31`,
      t.human,
    );
    expect(res.status).toBe(200);
    expect(SalesByItemList.parse(await res.json()).items).toEqual([
      {
        itemId: serviceId,
        itemCode: "RPT-SV",
        itemNameEn: "RPT-SV",
        deliveredQuantity: "0.000000",
        cost: { amount: "0.0000", currency: "MYR" },
        revenue: { amount: "50.0000", currency: "MYR" },
        margin: { amount: "50.0000", currency: "MYR" },
      },
    ]);
  });

  it("sales_by_item's date range is required — a missing one is a validation failure, not a default", async () => {
    const res = await get(`/v1/companies/${s.company}/reports/inventory.sales_by_item`);
    // 400: §4.2.4 fixes ERR_VALIDATION_FAILED at 400, and every Zod query failure reaches the wire so.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a principal without the report's code is refused with ERR_RBAC_FORBIDDEN", async () => {
    const other = await seedTenantV2(api.db, "NoReports");
    for (const path of [
      `/v1/companies/${other.company}/reports/inventory.stock_on_hand`,
      `/v1/companies/${other.company}/reports/inventory.valuation?asOf=2026-12-31`,
      `/v1/companies/${other.company}/reports/inventory.sales_by_item?fromDate=2026-01-01&toDate=2026-12-31`,
    ]) {
      const res = await get(path, other.human);
      expect(res.status, path).toBe(403);
      expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
    }
  });

  it("an unknown query key is refused rather than silently dropped (.strict(), §4.2.8)", async () => {
    const res = await get(
      `/v1/companies/${s.company}/reports/inventory.stock_on_hand?filter[item_code][eq]=RPT-1`,
    );
    // 400: §4.2.4 fixes ERR_VALIDATION_FAILED at 400, and every Zod query failure reaches the wire so.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a cursor of the wrong arity is refused, and the message names the report it was offered to", async () => {
    const wrong = encodeCursor({ k: ["only-one-key"], id: itemId });
    const res = await get(
      `/v1/companies/${s.company}/reports/inventory.stock_on_hand?cursor=${wrong}`,
    );
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toContain("inventory.stock_on_hand");
  });

  it("includeInTransit=false is honoured rather than coerced to true (z.stringbool)", async () => {
    // `z.coerce.boolean()` would make the string "false" truthy and quietly turn the corridor rows on.
    const res = await get(
      `/v1/companies/${s.company}/reports/inventory.stock_on_hand?includeInTransit=false`,
    );
    expect(res.status).toBe(200);
    expect(StockOnHandReportList.parse(await res.json()).items).toHaveLength(1);
  });

  /**
   * Code review 2, S1. spec:2158 — the clerk "May not: … see costs". The route stays gated by
   * `inventory.stock.read` (§4.16.1), which the clerk holds, so the cost is withheld FIELD BY FIELD: `cost`
   * and `margin` (revenue − margin is the cost) are null unless the caller also holds `inventory.cost.read`
   * at the report's scope, and the document read nulls `lines[].cost` on the same rule. Before the fix the
   * clerk read `cost 10.0000`, `margin -10.0000` and `lines[0].cost "10.0000"`.
   */
  describe("cost and margin are withheld from a caller without inventory.cost.read (S1)", () => {
    let t: Seed;
    let clerk: string;
    let branchCostReader: string;
    let deliveryId: string;
    let tItemId: string;

    beforeAll(async () => {
      t = await seedTenantV2(api.db, "SalesByItemCostSight");
      // The cost reader and poster: every figure below is theirs, unchanged by the fix.
      await grantCodes(api.db, t, {
        codes: ["inventory.stock.read", "inventory.cost.read", "accounting.journal.post"],
        roleCode: "cost-sight-reader",
      });
      // The clerk: EXACTLY the seeded `user` role's codes.
      const userRole = ROLES.find((role) => role.code === "user")!;
      expect(userRole.permissions).toContain("inventory.stock.read");
      expect(userRole.permissions).not.toContain("inventory.cost.read");
      clerk = await secondPrincipal(api.db, t, "cost-sight-clerk");
      await grantCodes(api.db, t, {
        codes: userRole.permissions,
        principalId: clerk,
        roleCode: "cost-sight-user",
      });
      // Stock read company-wide, cost read at HQ only: the report without a branch filter is company-wide
      // and asks company-wide authority, so this caller sees the cost only when it narrows to HQ.
      branchCostReader = await secondPrincipal(api.db, t, "cost-sight-branch");
      await grantCodes(api.db, t, {
        codes: ["inventory.stock.read"],
        principalId: branchCostReader,
        roleCode: "cost-sight-stock",
      });
      await grantCodes(api.db, t, {
        codes: ["inventory.cost.read"],
        principalId: branchCostReader,
        roleCode: "cost-sight-hq-cost",
        branchIds: [t.hq],
      });

      const receipt = await seedDocumentType(api.db, t, {
        code: "STOCK_RECEIPT_TEST",
        module: "inventory",
        policy: STOCK_RECEIPT_COST_POLICY,
      });
      // `salesByItem` counts movements of the type CODED `DELIVERY_ORDER`; the cost-at-line.cost issue pair
      // is the fixture's, under that code.
      const delivery = await seedDocumentType(api.db, t, {
        code: "DELIVERY_ORDER",
        module: "inventory",
        policy: {
          ...STOCK_ISSUE_COST_POLICY,
          documentType: "DELIVERY_ORDER",
          numbering: { series: "DOT", assignAt: "issue" },
          reversal: { allowed: true, producesType: "DELIVERY_ORDER" },
        },
      });
      ({ itemId: tItemId } = await seedItem(api.db, t, { code: "CS-1", trackLots: false }));
      const wh = await seedWarehouse(api.db, t, { code: "CS-WH" });
      await postInventoryDocument(api.db, t, {
        documentTypeId: receipt,
        warehouseId: wh,
        effectiveDate: "2026-01-10",
        jobs: recordingJobs(),
        lines: [{ itemId: tItemId, warehouseId: wh, quantity: "40.000000", unitPrice: "2.5000" }],
      });
      ({ documentId: deliveryId } = await postInventoryDocument(api.db, t, {
        documentTypeId: delivery,
        warehouseId: wh,
        effectiveDate: "2026-01-12",
        jobs: recordingJobs(),
        lines: [{ itemId: tItemId, warehouseId: wh, quantity: "4.000000", unitPrice: "0.0000" }],
      }));
      await api.loadPrincipals();
    }, 180_000);

    const report = (query = "") =>
      `/v1/companies/${t.company}/reports/inventory.sales_by_item?fromDate=2026-01-01&toDate=2026-01-31${query}`;

    it("the clerk (ROLES.user) gets deliveredQuantity and revenue, and null cost and margin", async () => {
      const res = await get(report(), clerk);
      expect(res.status).toBe(200);
      expect(SalesByItemList.parse(await res.json()).items).toEqual([
        {
          itemId: tItemId,
          itemCode: "CS-1",
          itemNameEn: "CS-1",
          deliveredQuantity: "4.000000",
          cost: null,
          revenue: { amount: "0.0000", currency: "MYR" },
          margin: null,
        },
      ]);
    });

    it("a cost.read holder still reads cost 10.0000 and margin -10.0000", async () => {
      const res = await get(report(), t.human);
      expect(res.status).toBe(200);
      expect(SalesByItemList.parse(await res.json()).items).toEqual([
        {
          itemId: tItemId,
          itemCode: "CS-1",
          itemNameEn: "CS-1",
          deliveredQuantity: "4.000000",
          cost: { amount: "10.0000", currency: "MYR" },
          revenue: { amount: "0.0000", currency: "MYR" },
          margin: { amount: "-10.0000", currency: "MYR" },
        },
      ]);
    });

    it("cost.read at one branch is asked at the report's scope: null company-wide, figures at that branch", async () => {
      const wide = await get(report(), branchCostReader);
      expect(wide.status).toBe(200);
      expect(SalesByItemList.parse(await wide.json()).items[0]).toMatchObject({
        cost: null,
        margin: null,
      });
      const atHq = await get(report(`&filter[branch_id][eq]=${t.hq}`), branchCostReader);
      expect(atHq.status).toBe(200);
      expect(SalesByItemList.parse(await atHq.json()).items[0]).toMatchObject({
        cost: { amount: "10.0000", currency: "MYR" },
        margin: { amount: "-10.0000", currency: "MYR" },
      });
    });

    it("GET …/documents/{id} nulls every line's cost for the clerk, and keeps it for a cost.read holder", async () => {
      const path = `/v1/companies/${t.company}/documents/${deliveryId}`;
      const asClerk = await get(path, clerk);
      expect(asClerk.status).toBe(200);
      const clerkDoc = DocumentSchema.parse(await asClerk.json());
      expect(clerkDoc.lines).toHaveLength(1);
      expect(clerkDoc.lines[0]!.cost).toBeNull();
      // Everything else on the line is the clerk's to read (spec:2158 — reads items and stock).
      expect(clerkDoc.lines[0]!.quantity).toBe("4.000000");

      const asReader = await get(path, t.human);
      expect(asReader.status).toBe(200);
      expect(DocumentSchema.parse(await asReader.json()).lines[0]!.cost).toBe("10.0000");
    });
  });
});

describe("the report register after 3D T10 (no database)", () => {
  it("all three codes live on 1B's reports module, and ROUTES has exactly one entry for that path", () => {
    const onPath = ROUTES.filter((entry) => entry.path === "/v1/companies/:companyId/reports");
    expect(onPath).toHaveLength(1); // a second module here would break the PROBES key
    // The members up to 4B's, in their order. Later slices APPEND (7B amendment A4: membership, never a total
    // count), so this pins the prefix 3D and 4B wrote, not the enum's length.
    expect(ReportCodeSchema.options.slice(0, 8)).toEqual([
      "pos.z_report",
      "pos.sales_by_cashier",
      "accounting.trial_balance",
      "accounting.ledger",
      "inventory.stock_on_hand",
      "inventory.valuation",
      "inventory.sales_by_item",
      // 4B T3 — widened in the PR that mounts the route (§4.16.3), on this same module.
      "accounting.ageing",
    ]);
    // …and 3B's own valuation MODULE is untouched by this slice: `inventory.valuation` as a report code and
    // `/v1/companies/:companyId/valuation` as a module are two surfaces over one read function, which is
    // what 3B's amendment A8 says in terms. A pass here that found ZERO valuation modules would mean this
    // slice had retired someone else's route — which it must not.
    expect(
      ROUTES.filter((entry) => entry.path === "/v1/companies/:companyId/valuation"),
    ).toHaveLength(1);
  });

  it("the reports module's permission list carries the two inventory read codes 3D's routes gate on", () => {
    const reports = ROUTES.find((entry) => entry.path === "/v1/companies/:companyId/reports");
    expect(reports?.permissions).toEqual([
      "pos.report.read",
      "accounting.report.read",
      "accounting.ledger.read",
      "inventory.stock.read",
      "inventory.cost.read",
      // 7A T12 — the POST …/{code}/runs sub-path's export gate.
      "accounting.report.export",
    ]);
  });
});
