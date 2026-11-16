import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  withTenant,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories
// up, which is what 2A's route suites use. There is no `apps/api/test/support/api.ts`.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let orderTypeId: string;
let receiptTypeId: string;
let itemId: string;
let baseUnitId: string;
let warehouseId: string;
let partyId: string;

const ORDER_POLICY = (code: string, series: string) => ({
  version: 1 as const,
  documentType: code,
  direction: "none" as const,
  requires: [] as const,
  lines: [] as const,
  inventory: { effect: "none" as const },
  tax: { applies: false },
  numbering: { series, assignAt: "issue" as const },
  reversal: { allowed: false, producesType: null },
  approval: { required: false, approve: null, post: "accounting.purchase.create" },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" as const },
  dimensions: { required: [] as const },
});

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "links-api");
  await grantAdmin(api, s);
  // `grantAdmin` grants the FIVE admin codes only (contracts §4.17.1), and neither gate on these three
  // sub-paths is an admin code: the POST resolves `approval.create ?? approval.post` from the target's
  // policy (`inventory.receipt.create`) and both GETs resolve the `inventory` row of the §4.5.8 module
  // read map (`inventory.stock.read`). Both document types below are `module: "inventory"` (§4.14).
  await grantCodes(api.db, s, {
    codes: ["inventory.receipt.create", "inventory.receipt.post", "inventory.stock.read"],
  });
  orderTypeId = await seedDocumentType(api.db, s, {
    code: "API_ORDER",
    module: "inventory",
    policy: ORDER_POLICY("API_ORDER", "AO"),
  });
  receiptTypeId = await seedDocumentType(api.db, s, {
    code: "API_RECEIPT",
    module: "inventory",
    policy: {
      ...ORDER_POLICY("API_RECEIPT", "AR"),
      approval: {
        required: false,
        approve: null,
        post: "inventory.receipt.post",
        create: "inventory.receipt.create",
      },
    },
  });
  ({ itemId, baseUnitId } = await seedItem(api.db, s, { code: "API-ITEM" }));
  warehouseId = await seedWarehouse(api.db, s, { code: "API-WH" });
  partyId = await seedParty(api.db, s, { kind: "vendor", code: "API-VEND" });
}, 240_000);
afterAll(async () => {
  await api.stop();
});

/** `amount` is the THIRD argument and is passed explicitly: it is `quantity × unitPrice` and computing it
 *  here would put a monetary value through JavaScript arithmetic (`no-number-money`, §3.7.5). Every call
 *  below states all three, so the row is the row the assertions expect. */
async function issuedOrder(
  quantity: string,
  unitPrice: string,
  amount: string,
): Promise<{ documentId: string; lineIds: string[] }> {
  const placed = await draftTypedDocument(api.db, s, {
    documentTypeId: orderTypeId,
    series: "AO",
    partyId,
    lines: [{ kind: "item", itemId, unitId: baseUnitId, quantity, unitPrice, amount }],
  });
  // draft → issued is legal with `approval.required = false` and evaluates no code (migration 0022,
  // ADR 0029), so the state machine is exercised as itself rather than bypassed.
  await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) => tx`update app.document set status = 'issued' where id = ${placed.documentId}`,
  );
  return placed;
}

describe("POST/GET /v1/companies/{companyId}/documents/{documentId}/links (3C)", () => {
  it("creates a link, prices the target line from the source, and reports the open quantity", async () => {
    const placed = await issuedOrder("100.000000", "5.0000", "500.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId,
      series: "AR",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "40.000000" }],
    });

    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`,
      as: s.human,
      body: {
        sourceDocumentId: placed.documentId,
        linkKind: "receives_against",
        priceFromSource: true,
        lines: [
          {
            sourceLineId: placed.lineIds[0],
            targetLineId: receipt.lineIds[0],
            quantity: "40.000000",
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: { linkKind: string; quantity: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ linkKind: "receives_against", quantity: "40.000000" });

    // The order's unit price reached the receipt line, and amount was recomputed from it (spec:1050).
    const [line] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ unit_price: string; amount: string }[]>`
        select unit_price::text as unit_price, amount::text as amount
          from app.document_line where id = ${receipt.lineIds[0]!}`,
    );
    expect(line).toEqual({ unit_price: "5.0000", amount: "200.0000" });

    const open = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/documents/${placed.documentId}/open-quantity`,
      as: s.human,
    });
    expect(open.status).toBe(200);
    const openBody = (await open.json()) as {
      items: { orderedQuantity: string; linkedQuantity: string; openQuantity: string }[];
    };
    expect(openBody.items[0]).toEqual({
      documentId: placed.documentId,
      documentLineId: placed.lineIds[0],
      lineNo: 1,
      itemId,
      orderedQuantity: "100.000000",
      linkedQuantity: "40.000000",
      openQuantity: "60.000000",
    });

    const list = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`,
      as: s.human,
    });
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("returns 422 ERR_DOC_LINK_OVER_FULFILLED when the link exceeds the open quantity", async () => {
    const placed = await issuedOrder("10.000000", "10.0000", "100.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId,
      series: "AR",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "11.000000" }],
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`,
      as: s.human,
      body: {
        sourceDocumentId: placed.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: placed.lineIds[0],
            targetLineId: receipt.lineIds[0],
            quantity: "11.000000",
          },
        ],
      },
    });
    expect(res.status).toBe(422);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_DOC_LINK_OVER_FULFILLED");
    expect(problem.detail).toContain("10.000000 ordered");
    expect(problem.remedy).toContain("open-quantity");
  });

  it("returns 409 ERR_DOC_NOT_DRAFT when the target has already been issued", async () => {
    const placed = await issuedOrder("5.000000", "5.0000", "25.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId,
      series: "AR",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "5.000000" }],
    });
    await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${receipt.documentId}`,
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`,
      as: s.human,
      body: {
        sourceDocumentId: placed.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: placed.lineIds[0],
            targetLineId: receipt.lineIds[0],
            quantity: "5.000000",
          },
        ],
      },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_NOT_DRAFT");
  });

  it("returns 400 ERR_VALIDATION_FAILED when a price would be copied from a tax-inclusive order onto an exclusive receipt", async () => {
    // 5A (PR 11 review, round 2): the copied price is GROSS on an inclusive order, and the receipt would read it
    // as net. `tax_inclusive` is written while the order is a draft — 0117 freezes the header after it.
    const placed = await draftTypedDocument(api.db, s, {
      documentTypeId: orderTypeId,
      series: "AO",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "3.000000",
          unitPrice: "11.1000",
          amount: "33.3000",
        },
      ],
    });
    await withTenant(api.db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.document set tax_inclusive = true where id = ${placed.documentId}`;
      await tx`update app.document set status = 'issued' where id = ${placed.documentId}`;
    });
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId,
      series: "AR",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "3.000000" }],
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`,
      as: s.human,
      body: {
        sourceDocumentId: placed.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: placed.lineIds[0],
            targetLineId: receipt.lineIds[0],
            quantity: "3.000000",
          },
        ],
      },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/draft the target with the same taxInclusive as its order/);
    // Refused before anything was written: no link, and the receipt line still carries no price.
    const [state] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ links: number; unitPrice: string | null }[]>`
        select (select count(*)::int from app.document_link
                 where target_document_id = ${receipt.documentId}) as links,
               (select unit_price::text from app.document_line
                 where id = ${receipt.lineIds[0]!}) as "unitPrice"`,
    );
    expect(state).toEqual({ links: 0, unitPrice: null });
  });

  it("requires an Idempotency-Key and replays the same key with the same body", async () => {
    const placed = await issuedOrder("8.000000", "8.0000", "64.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId,
      series: "AR",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "8.000000" }],
    });
    const body = {
      sourceDocumentId: placed.documentId,
      linkKind: "receives_against",
      lines: [
        { sourceLineId: placed.lineIds[0], targetLineId: receipt.lineIds[0], quantity: "8.000000" },
      ],
    };
    const path = `/v1/companies/${s.company}/documents/${receipt.documentId}/links`;

    const missing = await api.request({
      method: "POST",
      path,
      as: s.human,
      body,
      idempotencyKey: null,
    });
    expect(missing.status).toBe(400);
    expect((await problemOf(missing)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const key = "3c-links-replay";
    const first = await api.request({
      method: "POST",
      path,
      as: s.human,
      body,
      idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    const replay = await api.request({
      method: "POST",
      path,
      as: s.human,
      body,
      idempotencyKey: key,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    const links = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document_link
         where target_document_id = ${receipt.documentId}`,
    );
    expect(links[0]!.n).toBe(1);
  });

  it("403s a principal that holds no create authority on the target's type", async () => {
    const placed = await issuedOrder("4.000000", "4.0000", "16.0000");
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: receiptTypeId,
      series: "AR",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "4.000000" }],
    });
    const stranger = await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      const [row] = await tx<{ id: string }[]>`select uuidv7() as id`;
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${row!.id}, 'human', ${`stranger:${s.tenant}`}, 'stranger')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${row!.id})`;
      return row!.id;
    });
    await api.loadPrincipals();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/links`,
      as: stranger,
      body: {
        sourceDocumentId: placed.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: placed.lineIds[0],
            targetLineId: receipt.lineIds[0],
            quantity: "4.000000",
          },
        ],
      },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });
});
