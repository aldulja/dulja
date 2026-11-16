import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  draftTypedDocument,
  grantCodes,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  withTenant,
  type Seed,
} from "@dulja/db/test";
// BOTH loaders through the `@dulja/db/seed` subpath (0C Task 12's export, `./src/seed/index.ts`). A route
// suite lives in `apps/api` and CANNOT reach into another package by relative path the way this slice's
// `packages/db` suites do (`../../src/seed/chart-of-accounts`), so the barrel is the only route — and 0C's
// barrel only imported `chartOfAccountsLoader` to populate its private `LOADERS` map. Task 9 adds the
// one-line re-export beside 1A's `documentTypesLoader`.
import { chartOfAccountsLoader, documentTypesLoader, type SubPack } from "@dulja/db/seed";
// FIVE levels up: this file is `apps/api/test/routes/accounting/`, which is 2A's route-suite depth.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let shipmentTypeId: string;
let orderTypeId: string;
let itemId: string;
let baseUnitId: string;
let warehouseId: string;
let partyId: string;
let freightAccountId: string;

// ABSOLUTE, built from this file's own location — five directories to the repository root, then down into
// the pack. §4.2.13's `LoaderContext.packRoot` is a path the loader `join`s against and promises nothing
// about a working directory, and Vitest runs this suite from `apps/api`, so the bare relative
// `"packages/db/seed/my"` would resolve under `apps/api/` and every loader call would raise ENOENT inside
// `beforeAll`, before any case ran.
const PACK_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "seed",
  "my",
);
const loaderCtx = (only: readonly SubPack[]) => ({
  config: {
    tenantId: s.tenant,
    only,
    packRoot: PACK_ROOT,
    appEnv: "dev" as const,
    tenantName: "lc-api",
    ownerEmail: "owner@example.invalid",
    companyCode: "HQ",
    companyName: "lc-api HQ",
    baseCurrency: "MYR",
    timezone: "Asia/Kuala_Lumpur",
    fiscalYearStartMonth: 1,
    fiscalYear: 2026,
  },
  tenantId: s.tenant,
  companyId: s.company,
  systemPrincipalId: s.system,
  packRoot: PACK_ROOT,
});

/** File-local, per §4.17: §4.2.12 gives `StartedApi` no lookup members and hazard 9 forbids adding one. */
async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}
async function accountId(code: string): Promise<string> {
  const [row] = await withTenant(
    api.db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    select id from app.account where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "lc-api");
  await grantAdmin(api, s);
  // `grantAdmin` grants the FIVE `admin.*` codes only (§4.17.1) and neither gate here is one of them: the
  // POST resolves `approval.create ?? approval.post` off SHIPMENT's policy (`inventory.receipt.create`),
  // and the GET resolves the `inventory` row of the §4.5.8 module read map. `accounting.purchase.create`
  // is PURCHASE_ORDER's `approval.post`, which the same gate resolves for the "does not receive stock"
  // case — without it that case is a 403 at the gate and never reaches the policy-shape refusal.
  await grantCodes(api.db, s, {
    codes: [
      "inventory.receipt.create",
      "inventory.receipt.post",
      "inventory.stock.read",
      "accounting.purchase.create",
    ],
  });
  // The seed pack, applied through 0C's loader seam (§4.2.13) — chart of accounts BEFORE document types, so
  // `2150` and `1300` resolve when the policies that name them are validated (hazard 33).
  await withTenant(api.db.migrator, s.tenant, s.system, (tx) =>
    chartOfAccountsLoader.load(tx, loaderCtx(["chart-of-accounts"])),
  );
  await withTenant(api.db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, loaderCtx(["document-types"])),
  );
  ({ itemId, baseUnitId } = await seedItem(api.db, s, { code: "LCAPI-ITEM" }));
  warehouseId = await seedWarehouse(api.db, s, { code: "LCAPI-WH" });
  partyId = await seedParty(api.db, s, { kind: "vendor", code: "LCAPI-VEND" });
  shipmentTypeId = await typeId("SHIPMENT");
  orderTypeId = await typeId("PURCHASE_ORDER");
  freightAccountId = await accountId("5900");
  await api.loadPrincipals();
}, 300_000);
afterAll(async () => {
  await api.stop();
});

async function draft(documentTypeId: string, series: string, withFreight: boolean) {
  return draftTypedDocument(api.db, s, {
    documentTypeId,
    series,
    partyId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        unitId: baseUnitId,
        warehouseId,
        quantity: "10.000000",
        unitPrice: "100.0000",
        amount: "1000.0000",
        customFields: { weight_kg: "25.000000" },
      },
      ...(withFreight
        ? [
            {
              kind: "account" as const,
              accountId: freightAccountId,
              description: "freight",
              amount: "120.0000",
            },
          ]
        : []),
    ],
  });
}

describe("POST/GET /v1/companies/{companyId}/documents/{documentId}/landed-cost (3C)", () => {
  it("allocates by_value and returns the rows and the per-line summary", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: s.human,
      idempotencyKey: "lc-1",
      body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      items: { targetLineId: string; method: string; allocatedAmount: string }[];
      summary: {
        targetLineId: string;
        lineAmount: string;
        allocated: string;
        landedAmount: string;
      }[];
    };
    expect(body.items.map((i) => [i.targetLineId, i.method, i.allocatedAmount])).toEqual([
      [lineIds[0]!, "by_value", "120.0000"],
    ]);
    expect(
      body.summary.map((r) => [r.targetLineId, r.lineAmount, r.allocated, r.landedAmount]),
    ).toEqual([[lineIds[0]!, "1000.0000", "120.0000", "1120.0000"]]);

    const get = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: s.human,
    });
    expect(get.status).toBe(200);
    const listed = (await get.json()) as { items: { allocatedAmount: string }[] };
    expect(listed.items.map((i) => i.allocatedAmount)).toEqual(["120.0000"]);
  });

  it("replays the same idempotency key without allocating twice", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    const call = () =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
        as: s.human,
        idempotencyKey: "lc-2",
        body: { allocations: [{ costLineId: lineIds[1]!, method: "by_weight" }] },
      });
    const first = await call();
    const second = await call();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });

  it("refuses a document whose policy does not receive stock, naming the type and the effect", async () => {
    const { documentId, lineIds } = await draft(orderTypeId, "PO", true);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: s.human,
      idempotencyKey: "lc-3",
      body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    // 400, not 422: §4.2.4 fixes `ERR_VALIDATION_FAILED` at status 400 and `AppError` takes its status from
    // `ERRORS[code].status`, so the handler's own `new AppError("ERR_VALIDATION_FAILED", …)` reaches the
    // wire as 400. 422 belongs to the codes §4.2.4 allocates there; none of them is raised on this path.
    expect(res.status).toBe(400);
    expect(await problemOf(res)).toMatchObject({
      code: "ERR_VALIDATION_FAILED",
      detail: expect.stringContaining("PURCHASE_ORDER has inventory.effect 'none'"),
    });
  });

  it("refuses an unknown method at the schema, before any query runs", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: s.human,
      idempotencyKey: "lc-4",
      body: { allocations: [{ costLineId: lineIds[1]!, method: "pro_rata" }] },
    });
    // 400: a Zod enum failure is `ERR_VALIDATION_FAILED`, which §4.2.4 fixes at 400.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("refuses a by_weight allocation over a line with no weight_kg, naming the line", async () => {
    const noWeight = await draftTypedDocument(api.db, s, {
      documentTypeId: shipmentTypeId,
      series: "SHP",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          warehouseId,
          quantity: "1.000000",
          unitPrice: "1.0000",
          amount: "1.0000",
        },
        {
          kind: "account",
          accountId: freightAccountId,
          description: "freight",
          amount: "10.0000",
        },
      ],
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${noWeight.documentId}/landed-cost`,
      as: s.human,
      idempotencyKey: "lc-5",
      body: { allocations: [{ costLineId: noWeight.lineIds[1]!, method: "by_weight" }] },
    });
    // 400: `LandedCostError("ERR_VALIDATION_FAILED", …)` is translated to `AppError` with the same code,
    // and §4.2.4 gives that code status 400.
    expect(res.status).toBe(400);
    expect((await problemOf(res)).detail).toContain("carries no weight_kg custom field");
  });

  it("refuses an allocation on a document that is no longer a draft, as 409 and not 500", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    // Straight to `issued` through `app_rw`, which is how Tasks 1 and 7 reach a non-draft status without
    // routing a transition — the point of this case is the DATABASE guard, not the lifecycle.
    await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.document set status = 'issued' where id = ${documentId}`,
    );
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: s.human,
      idempotencyKey: "lc-7",
      body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    // The refusal is migration 0038's `landed_cost_allocation_draft_only` trigger, raising
    // `ERR_DOC_NOT_DRAFT: document … is issued — landed cost is allocated on a draft, …` as a
    // check_violation. It is NOT a `LandedCostError`, so it reaches the wire only through the handler's
    // `asAppError`; without that translation this case reports 500 `ERR_INTERNAL`, which is exactly the
    // hole this case exists to hold closed. 409 is §4.2.4's status for `ERR_DOC_NOT_DRAFT` (2B's row).
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_NOT_DRAFT");
  });

  it("refuses a principal with no codes at all (ERR_RBAC_FORBIDDEN)", async () => {
    const { documentId, lineIds } = await draft(shipmentTypeId, "SHP", true);
    // A tenant MEMBER holding no role at all — the "authenticated but unauthorised" shape. Not `s.system`:
    // `app.actor_has` answers TRUE for the tenant's system principal (0001), so it passes every gate.
    const nobody = await secondPrincipal(api.db, s, "lc-nobody");
    await api.loadPrincipals();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: nobody,
      idempotencyKey: "lc-6",
      body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("returns ERR_NOT_FOUND for another tenant's document (test 12)", async () => {
    const other = await seedTenantV2(api.db, "lc-api-other");
    await grantAdmin(api, other);
    await grantCodes(api.db, other, { codes: ["inventory.stock.read"] });
    await api.loadPrincipals();
    const { documentId } = await draft(shipmentTypeId, "SHP", true);
    // Tenant B's principal, tenant B's company path, tenant A's document id: RLS makes it invisible, so the
    // answer is 404 and never an empty 200 — an empty list would tell B that the id exists somewhere.
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${other.company}/documents/${documentId}/landed-cost`,
      as: other.human,
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });
});

describe("INV-03 — posting a receipt whose freight line is not wholly allocated (ADR 0041 amendment)", () => {
  it("refuses the post with 422 ERR_POLICY_REQUIRES_MISSING once PUT …/lines cascaded the allocation away", async () => {
    // Not lot-tracked: the suite's item is (seedItem's default), and a lot-tracked receipt naming no lot is
    // refused by planMovements with the same code before this check is reached.
    const plain = await seedItem(api.db, s, { code: "LCAPI-INV03", trackLots: false });
    const { documentId, lineIds } = await draftTypedDocument(api.db, s, {
      documentTypeId: shipmentTypeId,
      series: "SHP",
      partyId,
      warehouseId,
      lines: [
        {
          kind: "item",
          itemId: plain.itemId,
          unitId: plain.baseUnitId,
          warehouseId,
          quantity: "10.000000",
          unitPrice: "100.0000",
          amount: "1000.0000",
        },
        {
          kind: "account",
          accountId: freightAccountId,
          description: "freight",
          amount: "120.0000",
        },
      ],
    });
    const allocated = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: s.human,
      idempotencyKey: "inv03-allocate",
      body: { allocations: [{ costLineId: lineIds[1]!, method: "by_value" }] },
    });
    expect(allocated.status).toBe(201);

    const replaced = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${documentId}/lines`,
      as: s.human,
      idempotencyKey: "inv03-replace",
      body: {
        lines: [
          {
            lineNo: 1,
            kind: "item",
            itemId: plain.itemId,
            warehouseId,
            quantity: "10.000000",
            unitPrice: "100.0000",
            amount: "1000.0000",
          },
          { lineNo: 2, kind: "account", accountId: freightAccountId, amount: "120.0000" },
        ],
      },
    });
    expect(replaced.status).toBe(200);
    const listed = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/documents/${documentId}/landed-cost`,
      as: s.human,
    });
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);

    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
      as: s.human,
      idempotencyKey: "inv03-post",
      body: { to: "posted" },
    });
    expect(posted.status).toBe(422);
    const problem = await problemOf(posted);
    expect(problem.code).toBe("ERR_POLICY_REQUIRES_MISSING");
    expect(problem.detail).toMatch(
      /line 2 capitalises 120\.0000 into inventory account .* but 0\.0000/,
    );
    const [doc] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; number: string | null }[]>`
      select status::text as status, number::text as number from app.document where id = ${documentId}`,
    );
    expect(doc).toEqual({ status: "draft", number: null });
  });
});
