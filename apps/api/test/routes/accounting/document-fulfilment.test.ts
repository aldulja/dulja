import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConvertResultSchema } from "@dulja/contracts";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  withTenant,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories
// up, which is what 2A's route suites use. There is no `apps/api/test/support/api.ts`.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let soType: string;
let itemId: string;
let baseUnitId: string;
let warehouseId: string;
let partyId: string;
let order: { documentId: string; lineIds: string[] };

/** The two policies, transcribed from the seed pack this slice ships (§4.14). `seedDocumentType` parses
 *  each against `posting-policy.schema.json` before it inserts, so a drifted copy fails here. */
const SALES_ORDER_POLICY = {
  version: 1,
  documentType: "SALES_ORDER",
  direction: "none",
  requires: ["party"],
  lines: [],
  inventory: { effect: "none" },
  tax: { applies: false },
  numbering: { series: "SO", assignAt: "issue" },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.sales.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: [] },
};

const DELIVERY_ORDER_POLICY = {
  version: 1,
  documentType: "DELIVERY_ORDER",
  direction: "outbound",
  requires: ["party", "warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { code: "1250" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item" },
    },
  ],
  inventory: {
    effect: "issue",
    warehouse: "line.warehouse",
    costing: "consume_layers",
    allowNegative: true,
  },
  tax: { applies: false },
  numbering: { series: "DO", assignAt: "issue" },
  reversal: { allowed: true, producesType: "DELIVERY_ORDER" },
  approval: {
    required: false,
    approve: null,
    post: "inventory.transfer.post",
    create: "inventory.transfer.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
};

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "convert-api");
  await grantAdmin(api, s);
  // `grantAdmin` grants the FIVE admin codes only (contracts §4.17.1). Two codes are needed here and for
  // two different gates: the path gate resolves the ORDER's `approval.create ?? approval.post`
  // (`accounting.sales.create`), and the handler's own check asks the BODY type's `approval.create`
  // (`inventory.transfer.create`) — which is the authority to ship stock.
  await grantCodes(api.db, s, {
    codes: ["accounting.sales.create", "inventory.transfer.create"],
  });
  await seedAccount(api.db, s, {
    code: "1250",
    nameEn: "Goods delivered not invoiced",
    type: "asset",
  });
  soType = await seedDocumentType(api.db, s, {
    code: "SALES_ORDER",
    module: "inventory",
    policy: SALES_ORDER_POLICY,
  });
  await seedDocumentType(api.db, s, {
    code: "DELIVERY_ORDER",
    module: "inventory",
    policy: DELIVERY_ORDER_POLICY,
  });
  partyId = await seedParty(api.db, s, { kind: "customer", code: "CONV-CUST" });
  warehouseId = await seedWarehouse(api.db, s, { code: "CONV-WH" });
  baseUnitId = await seedUnit(api.db, s, { code: "PCS" });
  ({ itemId } = await seedItem(api.db, s, { code: "CONV-ITEM", baseUnitId }));
  order = await draftTypedDocument(api.db, s, {
    documentTypeId: soType,
    series: "SO",
    effectiveDate: "2026-01-10",
    partyId,
    lines: [
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        warehouseId,
        quantity: "10.000000",
        unitPrice: "5.0000",
        amount: "50.0000",
      },
    ],
  });
  // draft → issued is legal with `approval.required = false` and evaluates no code (migration 0022,
  // ADR 0029), so the state machine is exercised as itself rather than bypassed.
  await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) => tx`update app.document set status = 'issued' where id = ${order.documentId}`,
  );
}, 240_000);
afterAll(async () => {
  await api.stop();
});

describe("POST /v1/companies/{companyId}/documents/{documentId}/convert (3D T5)", () => {
  it("201s and returns a body that validates against ConvertResultSchema", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human,
      idempotencyKey: "conv-201",
      body: {
        targetDocumentTypeCode: "DELIVERY_ORDER",
        targetSeries: "DO",
        effectiveDate: "2026-01-12",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(201);
    // `parse`, not `safeParse().success`: a failure must name the member that did not match.
    const body = ConvertResultSchema.parse(await res.json());
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]!.quantity).toBe("1.000000");
    expect(body.links.map((l) => l.linkKind)).toEqual(["converts_to"]);
  });

  it("400s a request with no Idempotency-Key (spec:2055, §4.2.9)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human,
      idempotencyKey: null, // the helper omits the header entirely
      body: {
        targetDocumentTypeCode: "DELIVERY_ORDER",
        targetSeries: "DO",
        effectiveDate: "2026-01-12",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("403s a principal who may raise orders but not ship stock (the handler asks the BODY's type)", async () => {
    const salesOnly = await secondPrincipal(api.db, s, "sales");
    await grantCodes(api.db, s, {
      codes: ["accounting.sales.create"],
      principalId: salesOnly,
      roleCode: "sales-only",
    });
    await api.loadPrincipals();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: salesOnly,
      idempotencyKey: "conv-403",
      body: {
        targetDocumentTypeCode: "DELIVERY_ORDER",
        targetSeries: "DO",
        effectiveDate: "2026-01-12",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("404s a target document type of another company, by code", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human,
      idempotencyKey: "conv-404",
      body: {
        targetDocumentTypeCode: "NOT_CONFIGURED",
        targetSeries: "DO",
        effectiveDate: "2026-01-12",
        warehouseId,
        fefo: false,
        lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });

  it("a replay of the same Idempotency-Key returns the SAME documentId and drafts no second delivery", async () => {
    const body = {
      targetDocumentTypeCode: "DELIVERY_ORDER",
      targetSeries: "DO",
      effectiveDate: "2026-01-13",
      warehouseId,
      fefo: false,
      lines: [{ sourceLineId: order.lineIds[0]!, quantity: "1.000000" }],
    };
    // Counted around the pair rather than absolutely: the 201 case above already converted part of this
    // order, so an absolute "exactly one" would be wrong for a reason that has nothing to do with replay.
    const targets = (): Promise<{ n: number }[]> =>
      withTenant(
        api.db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ n: number }[]>`
          select count(distinct target_document_id)::int as n
            from app.document_link where source_document_id = ${order.documentId}`,
      );
    const [before] = await targets();
    const first = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human,
      idempotencyKey: "conv-replay",
      body,
    });
    const second = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${order.documentId}/convert`,
      as: s.human,
      idempotencyKey: "conv-replay",
      body,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = ConvertResultSchema.parse(await first.json());
    const b = ConvertResultSchema.parse(await second.json());
    expect(b.documentId).toBe(a.documentId);
    // …and the replay was served from the idempotency record rather than re-run: the pair added exactly ONE
    // delivery to the order, which a second draft would have made two.
    const [after] = await targets();
    expect(after!.n).toBe(before!.n + 1);
  });
});
