import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TransferDraftSchema } from "@dulja/contracts";
import { postDocument } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedBranch,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  uuidv7,
  withTenant,
  type Seed,
} from "@dulja/db/test";
import { chartOfAccountsLoader, documentTypesLoader, type SubPack } from "@dulja/db/seed";
// FIVE levels up: this file sits at `apps/api/test/routes/accounting/`, which is 2A's route-suite depth.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { secondPrincipal } from "../../../../../tests/invariants/support/post-inventory";
import { startApi, type StartedApi } from "../../support/app";

let api: StartedApi;
let s: Seed;
let itemId: string;
let unitId: string;
let whHq: string;
let whBranch: string;
let whTransit: string;
let branchB: string;

/** ABSOLUTE, built from this file's own location: §4.2.13's `LoaderContext.packRoot` promises nothing about
 *  a working directory, and Vitest runs this suite from `apps/api`. */
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
    tenantName: "trf-api",
    ownerEmail: "owner@example.invalid",
    companyCode: "HQ",
    companyName: "trf-api HQ",
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

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "trf-api");
  await grantAdmin(api, s);
  // `grantAdmin` grants the five `admin.*` codes only (§4.17.1) and the gate here is none of them: the POST
  // resolves `approval.create` off TRANSFER's own policy (`inventory.transfer.create`).
  await grantCodes(api.db, s, {
    codes: ["inventory.transfer.create", "inventory.transfer.post"],
  });
  // chart-of-accounts BEFORE document-types (hazard 33): `1310` must resolve before the TRANSFER policy
  // naming it is validated. This is also what proves `TRANSFER.json` itself parses and validates.
  await withTenant(api.db.migrator, s.tenant, s.system, (tx) =>
    chartOfAccountsLoader.load(tx, loaderCtx(["chart-of-accounts"])),
  );
  await withTenant(api.db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, loaderCtx(["document-types"])),
  );
  ({ itemId, baseUnitId: unitId } = await seedItem(api.db, s, { code: "TRFAPI-ITEM" }));
  branchB = await seedBranch(api.db, s, { code: "TRF-BR2", nameEn: "Branch 2" });
  whHq = await seedWarehouse(api.db, s, { code: "TRFAPI-HQ", kind: "stock", branchId: s.hq });
  whBranch = await seedWarehouse(api.db, s, {
    code: "TRFAPI-BR2",
    kind: "stock",
    branchId: branchB,
  });
  whTransit = await seedWarehouse(api.db, s, {
    code: "TRFAPI-BR2-TR",
    kind: "in_transit",
    branchId: branchB,
  });
  await api.loadPrincipals();
}, 300_000);
afterAll(async () => {
  await api.stop();
});

const bodyFor = (toWarehouseId: string) => ({
  documentTypeCode: "TRANSFER",
  series: "TRF",
  effectiveDate: "2026-01-10",
  fromWarehouseId: whHq,
  toWarehouseId,
  lines: [{ itemId, unitId, quantity: "1.000000" }],
});

describe("POST …/documents/transfers (3D T7)", () => {
  it("201s, and the corridor in the response is the DESTINATION branch's in-transit warehouse", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: "trf-201",
      body: bodyFor(whBranch),
    });
    expect(res.status).toBe(201);
    const body = TransferDraftSchema.parse(await res.json());
    // The client named the FINAL destination; the server resolved the corridor. A response echoing
    // `whBranch` here would mean the goods were about to post straight into the destination, which is the
    // definition-of-done clause failing silently (ADR 0043's decision 2).
    expect(body.inTransitWarehouseId).toBe(whTransit);
    expect(body.lineIds).toHaveLength(1);
  });

  it("400s a request with no Idempotency-Key (spec:2055, §4.2.9)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: null,
      body: bodyFor(whBranch),
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("403s a principal who does not hold inventory.transfer.create", async () => {
    const salesOnly = await secondPrincipal(api.db, s, "trf-sales");
    await grantCodes(api.db, s, {
      codes: ["accounting.sales.create"],
      principalId: salesOnly,
      roleCode: "trf-sales-only",
    });
    await api.loadPrincipals();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: salesOnly,
      idempotencyKey: "trf-403",
      body: bodyFor(whBranch),
    });
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("400s a destination branch with no in-transit warehouse, naming the branch", async () => {
    const branchC = await seedBranch(api.db, s, { code: "TRF-BR3", nameEn: "Branch 3" });
    const whC = await seedWarehouse(api.db, s, {
      code: "TRFAPI-BR3",
      kind: "stock",
      branchId: branchC,
    });
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: "trf-no-corridor",
      body: bodyFor(whC),
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    // The message is `resolveInTransitWarehouse`'s own, reaching the wire through `asAppError` unchanged —
    // a configuration gap must be loud and must say what to create (ADR 0043's decision 2).
    expect(problem.detail).toMatch(
      /has no in_transit warehouse; configure one before transferring to TRFAPI-BR3/,
    );
  });

  it("404s a warehouse that is not this company's, without confirming it exists", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: "trf-404",
      body: bodyFor("00000000-0000-7000-8000-000000000000"),
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });
});

/**
 * 2026-11-15 review, INV-10. `document_line`'s item, lot and unit keys are tenant-composite only, so the
 * dispatch route binds each line's item, unit and lot to the PATH company, and the lot to its line's item —
 * the generic line route's check (`routes/accounting/documents.ts`), plus the lot-to-item binding. A
 * refused line drafts nothing.
 */
describe("POST …/documents/transfers binds every line reference (INV-10)", () => {
  let siblingItem: string;
  let siblingUnit: string;
  let otherItemLot: string;

  beforeAll(async () => {
    const sibling = await uuidv7(api.db.admin);
    siblingUnit = await uuidv7(api.db.admin);
    siblingItem = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${sibling}, ${s.tenant}, 'TRF-SIB', 'Sibling company', 'MYR')`;
      await tx`insert into app.unit_of_measure (id, tenant_id, company_id, code, name_en)
               values (${siblingUnit}, ${s.tenant}, ${sibling}, 'PCS', 'Pieces')`;
      await tx`insert into app.item (id, tenant_id, company_id, code, name_en, kind, base_unit_id)
               values (${siblingItem}, ${s.tenant}, ${sibling}, 'SIB-ITEM', 'Sibling item', 'product',
                       ${siblingUnit})`;
    });
    const { itemId: otherItem } = await seedItem(api.db, s, {
      code: "TRFAPI-OTHER",
      baseUnitId: unitId,
    });
    const [lot] = await withTenant(
      api.db.migrator,
      s.tenant,
      s.system,
      (tx) => tx<{ id: string }[]>`select id from app.lot where item_id = ${otherItem}`,
    );
    otherItemLot = lot!.id;
  }, 120_000);

  const transfersIn = async (): Promise<number> => {
    const [row] = await withTenant(
      api.db.migrator,
      s.tenant,
      s.system,
      (tx) =>
        tx<{ n: number }[]>`
        select count(*)::int as n from app.document
         where company_id = ${s.company} and to_warehouse_id = ${whTransit}`,
    );
    return row!.n;
  };

  const dispatch = (line: Record<string, unknown>, idempotencyKey: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey,
      body: { ...bodyFor(whBranch), lines: [{ quantity: "1.000000", ...line }] },
    });

  it.each([
    ["another company's item", () => ({ itemId: siblingItem, unitId })],
    ["another company's unit", () => ({ itemId, unitId: siblingUnit })],
    ["a lot of another item", () => ({ itemId, unitId, lotId: otherItemLot })],
  ])("404s a line naming %s and drafts nothing", async (label, line) => {
    const before = await transfersIn();
    const res = await dispatch(line(), `inv10-${label.replace(/\W+/g, "-")}`);
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
    expect(await transfersIn()).toBe(before);
  });
});

// Code review 3 (Phase 4), the verification of R3. Both routes take `documentTypeCode` from the body and their
// services asked nothing of the type, so on c7d26b4 a receipt drafted as a TRANSFER and a dispatch drafted as
// a TRANSFER_RECEIPT were both 201s, and each posted its ledger against its own stock. The services now refuse
// a type whose policy is not the leg they draft, by shape (packages/db/src/inventory/transfer.ts).
describe("the transfer routes refuse a type of the other leg's shape", () => {
  let shapeItemId: string;
  let shapeUnitId: string;
  let transferId: string;
  let transferLineId: string;

  const documentCount = async () => {
    const [row] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document where company_id = ${s.company}`,
    );
    return row!.n;
  };

  beforeAll(async () => {
    await grantCodes(api.db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
    await api.loadPrincipals();
    ({ itemId: shapeItemId, baseUnitId: shapeUnitId } = await seedItem(api.db, s, {
      code: "TRFAPI-SHAPE",
      trackLots: false,
    }));
    const partyId = await seedParty(api.db, s, { code: "TRF-SUP", kind: "vendor" });
    const [grn] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${s.company} and code = 'GOODS_RECEIPT'`,
    );
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "trf-shape-grn" };
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: grn!.id,
      series: "GRN",
      effectiveDate: "2026-01-05",
      partyId,
      warehouseId: whHq,
      lines: [
        {
          kind: "item",
          itemId: shapeItemId,
          warehouseId: whHq,
          unitId: shapeUnitId,
          quantity: "10.000000",
          unitPrice: "5.0000",
          amount: "50.0000",
        },
      ],
    });
    await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      postDocument(tx, ctx, { documentId: receipt.documentId }),
    );
    // A POSTED dispatch of 4 through the route, for the receipt route to be asked of.
    const drafted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: "trf-shape-dispatch",
      body: {
        ...bodyFor(whBranch),
        lines: [{ itemId: shapeItemId, unitId: shapeUnitId, quantity: "4.000000" }],
      },
    });
    expect(drafted.status).toBe(201);
    const dispatch = TransferDraftSchema.parse(await drafted.json());
    transferId = dispatch.documentId;
    transferLineId = dispatch.lineIds[0]!;
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${transferId}/transitions`,
      as: s.human,
      idempotencyKey: "trf-shape-post",
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
  }, 120_000);

  it("POST …/documents/{id}/receipt with documentTypeCode TRANSFER is a 400 and drafts nothing; TRANSFER_RECEIPT still 201s", async () => {
    const receive = (documentTypeCode: string, series: string, idempotencyKey: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${transferId}/receipt`,
        as: s.human,
        idempotencyKey,
        body: {
          documentTypeCode,
          series,
          effectiveDate: "2026-01-12",
          received: [{ transferLineId, countedQuantity: "3.000000" }],
        },
      });
    const before = await documentCount();
    const res = await receive("TRANSFER", "TRF", "trf-shape-receipt-400");
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/document type TRANSFER is not a transfer receipt/);
    expect(await documentCount()).toBe(before);

    const control = await receive("TRANSFER_RECEIPT", "TRR", "trf-shape-receipt-201");
    expect(control.status).toBe(201);
  });

  it("POST …/documents/transfers with documentTypeCode TRANSFER_RECEIPT is a 400 and drafts nothing", async () => {
    const before = await documentCount();
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: "trf-shape-dispatch-400",
      body: {
        ...bodyFor(whBranch),
        documentTypeCode: "TRANSFER_RECEIPT",
        series: "TRR",
        lines: [{ itemId: shapeItemId, unitId: shapeUnitId, quantity: "1.000000" }],
      },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/document type TRANSFER_RECEIPT is not a transfer dispatch/);
    expect(await documentCount()).toBe(before);
  });

  it("PUT …/lines may move a TRANSFER_RECEIPT draft's line to a stock warehouse, and the post is then a 400 that writes nothing", async () => {
    // PUT …/lines binds a line's warehouse to the company and asks nothing of its kind. On d175409 this
    // receipt then posted WH-HQ → WH-BR2 (two stock warehouses) beside Dr 1300 / Cr 1310: 1300 up and 1310
    // down by the goods' value while neither the stock warehouses' value nor the corridor's moved.
    const drafted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: "trf-kind-dispatch",
      body: {
        ...bodyFor(whBranch),
        lines: [{ itemId: shapeItemId, unitId: shapeUnitId, quantity: "2.000000" }],
      },
    });
    expect(drafted.status).toBe(201);
    const dispatch = TransferDraftSchema.parse(await drafted.json());
    const transition = (documentId: string, idempotencyKey: string) =>
      api.request({
        method: "POST",
        path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
        as: s.human,
        idempotencyKey,
        body: { to: "posted" },
      });
    expect((await transition(dispatch.documentId, "trf-kind-dispatch-post")).status).toBe(200);
    const received = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${dispatch.documentId}/receipt`,
      as: s.human,
      idempotencyKey: "trf-kind-receipt",
      body: { documentTypeCode: "TRANSFER_RECEIPT", series: "TRR", effectiveDate: "2026-01-12" },
    });
    expect(received.status).toBe(201);
    const receipt = TransferDraftSchema.parse(await received.json());
    const replaced = await api.request({
      method: "PUT",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/lines`,
      as: s.human,
      idempotencyKey: "trf-kind-lines",
      body: {
        lines: [
          {
            lineNo: 1,
            kind: "item",
            itemId: shapeItemId,
            warehouseId: whHq,
            quantity: "2.000000",
          },
        ],
      },
    });
    expect(replaced.status).toBe(200);

    const res = await transition(receipt.documentId, "trf-kind-receipt-post");
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(
      /the TRANSFER_RECEIPT policy posts a transfer receipt, whose issue leg must be at an in_transit warehouse; this line's is at stock warehouse TRFAPI-HQ/,
    );
    const [row] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; ledger: number; moves: number }[]>`
        select d.status::text as status,
               (select count(*)::int from app.ledger_entry e where e.document_id = d.id) as ledger,
               (select count(*)::int from app.inventory_movement m where m.document_id = d.id) as moves
          from app.document d where d.id = ${receipt.documentId}`,
    );
    expect(row).toEqual({ status: "draft", ledger: 0, moves: 0 });
  });

  // Full review 2026-11-15, INV-05: `PATCH …/counts` never asked what the document was, so it rewrote a draft
  // receipt's counted quantity behind its dispatch link — a total loss turned into a full arrival, or the other
  // way. The service now refuses anything but a count sheet, by policy shape.
  it("PATCH …/counts on a draft TRANSFER_RECEIPT is a 400 and leaves the receipt line as drafted", async () => {
    const drafted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as: s.human,
      idempotencyKey: "trf-counts-dispatch",
      body: {
        ...bodyFor(whBranch),
        lines: [{ itemId: shapeItemId, unitId: shapeUnitId, quantity: "1.000000" }],
      },
    });
    expect(drafted.status).toBe(201);
    const dispatch = TransferDraftSchema.parse(await drafted.json());
    const posted = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${dispatch.documentId}/transitions`,
      as: s.human,
      idempotencyKey: "trf-counts-dispatch-post",
      body: { to: "posted" },
    });
    expect(posted.status).toBe(200);
    const received = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${dispatch.documentId}/receipt`,
      as: s.human,
      idempotencyKey: "trf-counts-receipt",
      body: {
        documentTypeCode: "TRANSFER_RECEIPT",
        series: "TRR",
        effectiveDate: "2026-01-12",
        received: [{ transferLineId: dispatch.lineIds[0]!, countedQuantity: "0.000000" }],
      },
    });
    expect(received.status).toBe(201);
    const receipt = TransferDraftSchema.parse(await received.json());

    const res = await api.request({
      method: "PATCH",
      path: `/v1/companies/${s.company}/documents/${receipt.documentId}/counts`,
      as: s.human,
      idempotencyKey: "trf-counts-patch",
      body: { counts: [{ documentLineId: receipt.lineIds[0]!, countedQuantity: "1.000000" }] },
    });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.detail).toMatch(/is not a stock-count sheet/);
    const [line] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ counted: string; quantity: string }[]>`
        select counted_quantity::text as counted, quantity::text as quantity
          from app.document_line where id = ${receipt.lineIds[0]!}`,
    );
    expect(line).toEqual({ counted: "0.000000", quantity: "-1.000000" });
  });
});

// 6C T5 and migration 0119 (contracts §4.5.6; ADR 0043's amendment, accepted by the owner 2026-11-04) — the
// routes' half of the "after 0068 and 0119" cases in packages/db/test/inventory/transfer-receipt.test.ts, which
// say why at the data layer. Until 0119 these cases PINNED that no branch-restricted principal could dispatch
// or receive here (ADR 0062's 2026-10-23 amendment). Now each route is gated at the branch the document it
// drafts will carry: the dispatch's create stage at the SOURCE warehouse's branch, never a branch the body
// names; the receipt at its corridor's branch, the RECEIVING branch, which also stamps it and gates its post.
// The receiving branch reads the posted dispatch through Form A's one widened read, and a third branch reads
// nothing.
describe("after 0068 and 0119 — branch-restricted principals at the transfer routes (ADR 0043's amendment; contracts §4.5.6)", () => {
  let isoItemId: string;
  let isoUnitId: string;
  let receiverB: string;
  let dispatcherA: string;
  let bothBranches: string;
  let thirdC: string;

  /** A fresh human holding the seeded branch_manager's two transfer codes (spec:2160) at `branchIds` only. */
  const restrictedTo = async (label: string, branchIds: readonly string[]): Promise<string> => {
    const id = await secondPrincipal(api.db, s, label);
    await grantCodes(api.db, s, {
      codes: ["inventory.transfer.create", "inventory.transfer.post"],
      principalId: id,
      roleCode: label,
      branchIds,
    });
    return id;
  };

  const documentCount = async () => {
    const [row] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.document where company_id = ${s.company}`,
    );
    return row!.n;
  };

  const post = (documentId: string, as: string, idempotencyKey: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${documentId}/transitions`,
      as,
      idempotencyKey,
      body: { to: "posted" },
    });

  const dispatch = (as: string, idempotencyKey: string, effectiveDate: string, extra = {}) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/transfers`,
      as,
      idempotencyKey,
      body: {
        ...bodyFor(whBranch),
        effectiveDate,
        lines: [{ itemId: isoItemId, unitId: isoUnitId, quantity: "1.000000" }],
        ...extra,
      },
    });

  const receive = (transferId: string, as: string, idempotencyKey: string, effectiveDate: string) =>
    api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/documents/${transferId}/receipt`,
      as,
      idempotencyKey,
      body: { documentTypeCode: "TRANSFER_RECEIPT", series: "TRR", effectiveDate },
    });

  const movementsOf = (documentId: string) =>
    withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ status: string; branch_id: string; warehouse_id: string; quantity: string }[]>`
        select d.status::text as status, d.branch_id, m.warehouse_id, m.quantity::text
          from app.document d join app.inventory_movement m on m.document_id = d.id
         where d.id = ${documentId} order by m.movement_no`,
    );

  /** A dispatch A → B drafted and posted through the routes by `as`, which must be able to do both. */
  const dispatched = async (as: string, key: string, effectiveDate: string): Promise<string> => {
    const drafted = await dispatch(as, key, effectiveDate);
    expect(drafted.status, key).toBe(201);
    const documentId = TransferDraftSchema.parse(await drafted.json()).documentId;
    expect((await post(documentId, as, `${key}-post`)).status, key).toBe(200);
    return documentId;
  };

  beforeAll(async () => {
    await grantCodes(api.db, s, { codes: ["inventory.receipt.create", "inventory.receipt.post"] });
    receiverB = await restrictedTo("trf-iso-receiver-b", [branchB]);
    dispatcherA = await restrictedTo("trf-iso-dispatcher-a", [s.hq]);
    bothBranches = await restrictedTo("trf-iso-both-branches", [s.hq, branchB]);
    const branchC = await seedBranch(api.db, s, { code: "TRF-BRC", nameEn: "Branch C" });
    thirdC = await restrictedTo("trf-iso-third-c", [branchC]);
    await api.loadPrincipals();
    ({ itemId: isoItemId, baseUnitId: isoUnitId } = await seedItem(api.db, s, {
      code: "TRFAPI-ISO",
      trackLots: false,
    }));
    const partyId = await seedParty(api.db, s, { code: "TRF-ISO-SUP", kind: "vendor" });
    const [grn] = await withTenant(
      api.db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.document_type where company_id = ${s.company} and code = 'GOODS_RECEIPT'`,
    );
    const receipt = await draftTypedDocument(api.db, s, {
      documentTypeId: grn!.id,
      series: "GRN",
      effectiveDate: "2026-01-05",
      partyId,
      warehouseId: whHq,
      lines: [
        {
          kind: "item",
          itemId: isoItemId,
          warehouseId: whHq,
          unitId: isoUnitId,
          quantity: "10.000000",
          unitPrice: "5.0000",
          amount: "50.0000",
        },
      ],
    });
    await withTenant(api.db.rw, s.tenant, s.human, (tx) =>
      postDocument(
        tx,
        { tenantId: s.tenant, actorId: s.human, requestId: "trf-iso-grn" },
        { documentId: receipt.documentId },
      ),
    );
  }, 120_000);

  // Every post below is dated after the one before it: a back-dated post enqueues the cost replay, which this
  // suite's job client refuses.

  it("POST …/transfers 201s for a principal restricted to the SENDING branch, gated at the source warehouse's branch, and it posts the dispatch; a principal not at that branch is 403", async () => {
    const documentId = await dispatched(dispatcherA, "trf-iso-dispatch-a", "2026-01-10");
    expect(await movementsOf(documentId)).toEqual([
      { status: "posted", branch_id: s.hq, warehouse_id: whHq, quantity: "-1.000000" },
      { status: "posted", branch_id: s.hq, warehouse_id: whTransit, quantity: "1.000000" },
    ]);

    // Restricted to B or to C, A's stock warehouse is hidden, so the gate finds no branch to ask at and asks
    // for company-wide authority, which neither holds.
    const before = await documentCount();
    for (const [as, key] of [
      [receiverB, "trf-iso-dispatch-b"],
      [thirdC, "trf-iso-dispatch-c"],
    ] as const) {
      const res = await dispatch(as, key, "2026-01-11");
      expect(res.status, key).toBe(403);
      const problem = await problemOf(res);
      expect(problem.code, key).toBe("ERR_RBAC_FORBIDDEN");
      expect(problem.detail, key).toBe(
        `inventory.transfer.create is required to create a TRANSFER in company ${s.company}`,
      );
    }
    expect(await documentCount()).toBe(before);

    // The control: granted both branches, a principal dispatches as well.
    await dispatched(bothBranches, "trf-iso-dispatch-both", "2026-01-11");
  });

  it("POST …/{id}/receipt 201s for a principal restricted to the RECEIVING branch, which posts it at B; a second receipt is 422 and a third branch 404s", async () => {
    const transferId = await dispatched(dispatcherA, "trf-iso-for-b", "2026-01-12");
    const before = await documentCount();

    // A third branch reads neither the dispatch nor anything else of it: the gate's own read 404s.
    const hidden = await receive(transferId, thirdC, "trf-iso-receipt-c", "2026-01-13");
    expect(hidden.status).toBe(404);
    const problem = await problemOf(hidden);
    expect(problem.code).toBe("ERR_NOT_FOUND");
    expect(problem.detail).toBe(`no document ${transferId} in company ${s.company}`);
    expect(await documentCount()).toBe(before);

    // The receiving branch, on its own authority: the receipt is stamped with B and its post gated at B.
    const res = await receive(transferId, receiverB, "trf-iso-receipt-b", "2026-01-13");
    expect(res.status).toBe(201);
    const receipt = TransferDraftSchema.parse(await res.json());
    expect(receipt.finalWarehouseId).toBe(whBranch);
    expect((await post(receipt.documentId, receiverB, "trf-iso-receipt-b-post")).status).toBe(200);
    expect(await movementsOf(receipt.documentId)).toEqual([
      { status: "posted", branch_id: branchB, warehouse_id: whTransit, quantity: "-1.000000" },
      { status: "posted", branch_id: branchB, warehouse_id: whBranch, quantity: "1.000000" },
    ]);

    // 0037's refusal of a second receipt of the same dispatch still holds.
    const again = await receive(transferId, receiverB, "trf-iso-receipt-b-again", "2026-01-13");
    expect(again.status).toBe(422);
    expect((await problemOf(again)).code).toBe("ERR_DOC_LINK_OVER_FULFILLED");

    // The control: granted both branches, a principal receives another dispatch the same way.
    const other = await dispatched(dispatcherA, "trf-iso-for-both", "2026-01-14");
    const control = await receive(other, bothBranches, "trf-iso-receipt-both", "2026-01-15");
    expect(control.status).toBe(201);
    const controlReceipt = TransferDraftSchema.parse(await control.json());
    expect(
      (await post(controlReceipt.documentId, bothBranches, "trf-iso-receipt-both-post")).status,
    ).toBe(200);
    expect((await movementsOf(controlReceipt.documentId))[0]!.branch_id).toBe(branchB);
  });

  // The create gate is asked at the SOURCE warehouse's branch, the branch `draftTransfer` stamps, and never at
  // a `branchId` in the body. Before the body was strict, a principal holding the create code at B alone named
  // `branchId: B`, cleared the gate there and drafted a dispatch stamped with A (201). Any company-wide role,
  // whatever its code, makes A's warehouse visible (`actor_in_branch` is not per-code), so the gate now asks
  // that principal at A — where it holds no create code — whatever the body says.
  it("POST …/transfers asks the gate at the source warehouse's branch, never at a branchId the body names", async () => {
    const steering = await restrictedTo("trf-iso-steer-b", [branchB]);
    await grantCodes(api.db, s, {
      codes: ["inventory.stock.read"],
      principalId: steering,
      roleCode: "trf-iso-steer-read",
    });
    await api.loadPrincipals();
    const before = await documentCount();
    for (const [extra, key] of [
      [{ branchId: branchB }, "trf-iso-steer-b"],
      [{}, "trf-iso-steer-none"],
    ] as const) {
      const res = await dispatch(steering, key, "2026-01-16", extra);
      expect(res.status, key).toBe(403);
      expect((await problemOf(res)).code, key).toBe("ERR_RBAC_FORBIDDEN");
    }
    // Cleared at A, a body naming any branchId is still refused by the strict body.
    const strict = await dispatch(dispatcherA, "trf-iso-steer-a", "2026-01-16", {
      branchId: branchB,
    });
    expect(strict.status).toBe(400);
    expect((await problemOf(strict)).code).toBe("ERR_VALIDATION_FAILED");
    expect(await documentCount()).toBe(before);
  });
});
