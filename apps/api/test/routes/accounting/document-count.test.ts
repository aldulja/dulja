import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CountSheetResultSchema } from "@dulja/contracts";
import { postDocument, withTenant } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedAccount,
  seedBranch,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
  type Seed,
} from "@dulja/db/test";
// FIVE levels: this file is `apps/api/test/routes/accounting/`, so the repository root is five directories
// up — the same path 2A's route suites use.
import { grantAdmin, problemOf } from "../../../../../tests/support/api";
import { pdfText } from "../../../../../tests/support/pdf";
import {
  ensureOpenPeriods,
  secondPrincipal,
} from "../../../../../tests/invariants/support/post-inventory";
import { closeChromium } from "../../../src/print/engines";
import { startApi, type StartedApi } from "../../support/app";

/** The seed-pack directory, five levels up and then into `packages/db`. Test 15's last case asserts that
 *  `COUNT_TEST.json` is NOT in it: the zero-code claim must be made about a type the release did not ship. */
const TYPES_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "seed",
  "my",
  "document-types",
);

/**
 * `STOCK_COUNT`'s policy, transcribed from `packages/db/seed/my/document-types/STOCK_COUNT.json`.
 * `packages/db/test/inventory/policies.ts` is a `packages/db` TEST file and is not part of
 * `@dulja/db/test`'s exports, so it is not importable from `apps/api`; the constant is repeated here for
 * the same reason 3D's other API-tier suites repeat theirs.
 */
const STOCK_COUNT_POLICY = {
  version: 1,
  documentType: "STOCK_COUNT",
  direction: "internal",
  requires: ["warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "5110" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "positive" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { from: "item.inventory_account" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
    {
      for: "each_line",
      side: "debit",
      account: { code: "5110" },
      amount: "line.cost",
      when: { "line.kind": "item", "line.quantity_sign": "negative" },
    },
  ],
  inventory: {
    effect: "receipt",
    warehouse: "line.warehouse",
    costing: "create_layer",
    allowNegative: false,
  },
  tax: { applies: false },
  numbering: { series: "SC", assignAt: "issue" },
  reversal: { allowed: true, producesType: "STOCK_COUNT" },
  approval: {
    required: true,
    approve: "inventory.adjustment.approve",
    post: "inventory.adjustment.approve",
    create: "inventory.count.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
};

const GRN_POLICY = {
  version: 1,
  documentType: "GOODS_RECEIPT",
  direction: "inbound",
  requires: ["party", "warehouse"],
  lines: [
    {
      for: "each_line",
      side: "debit",
      account: { from: "item.inventory_account" },
      amount: "line.amount",
      when: { "line.kind": "item" },
    },
    {
      for: "each_line",
      side: "credit",
      account: { code: "2150" },
      amount: "line.amount",
      when: { "line.kind": "item" },
    },
  ],
  inventory: { effect: "receipt", warehouse: "line.warehouse", costing: "create_layer" },
  tax: { applies: false },
  numbering: { series: "GRN", assignAt: "issue" },
  reversal: { allowed: true, producesType: "GOODS_RECEIPT" },
  approval: {
    required: false,
    approve: null,
    post: "inventory.receipt.post",
    create: "inventory.receipt.create",
  },
  fxRoundingAccount: { from: "company.fx_rounding_account_id" },
  dimensions: { required: ["BRANCH"] },
};

/** §4.14's `COUNT_TEST` — test only, never a seed file. The same four variance rules as `STOCK_COUNT`,
 *  its own series `CT`, and `approve`/`post` both `inventory.adjustment.approve`. Declared as a REQUEST
 *  BODY rather than a fixture constant in `packages/db`, which is the whole point of test 15. */
const COUNT_TEST_POLICY = {
  ...STOCK_COUNT_POLICY,
  documentType: "COUNT_TEST",
  numbering: { series: "CT", assignAt: "issue" },
  reversal: { allowed: true, producesType: "COUNT_TEST" },
};

let api: StartedApi;
let s: Seed;
let warehouseId: string;
let unitId: string;
let itemId: string;
let partyId: string;
let counter: string;
let checker: string;
/** A sheet left in DRAFT with one count entered — the `GET` case reads it. */
let sheetId: string;
/** A second sheet, SUBMITTED — the "PATCH on a non-draft" case needs one that cannot be edited. */
let submittedSheetId: string;
let submittedLineId: string;

const docs = (): string => `/v1/companies/${s.company}/documents`;

/** Snapshot a sheet through the route, as the counter. */
const postSheet = async (
  idempotencyKey: string,
  effectiveDate: string,
  typeCode = "STOCK_COUNT",
) => {
  const res = await api.request({
    method: "POST",
    path: `${docs()}/count-sheet`,
    as: counter,
    idempotencyKey,
    body: {
      documentTypeCode: typeCode,
      series: typeCode === "COUNT_TEST" ? "CT" : "SC",
      effectiveDate,
      warehouseId,
    },
  });
  expect(res.status).toBe(201);
  return CountSheetResultSchema.parse(await res.json());
};

const patchCounts = (
  documentId: string,
  documentLineId: string,
  countedQuantity: string,
  idempotencyKey: string,
) =>
  api.request({
    method: "PATCH",
    path: `${docs()}/${documentId}/counts`,
    as: counter,
    idempotencyKey,
    body: { counts: [{ documentLineId, countedQuantity }] },
  });

const transition = (documentId: string, to: string, as: string, idempotencyKey: string) =>
  api.request({
    method: "POST",
    path: `${docs()}/${documentId}/transitions`,
    as,
    idempotencyKey,
    body: { to },
  });

beforeAll(async () => {
  api = await startApi();
  s = await seedTenantV2(api.db, "count-api");
  // Every sheet below is dated in February or March 2026, which Plan 0A's `seedTenant` seeds CLOSED and
  // LOCKED; issuing into either is ERR_PERIOD_NOT_OPEN before R1 or the variance is ever reached. The same
  // twelve open months the packages/db stock-count suite posts into.
  await ensureOpenPeriods(api.db, s, 2026);
  // Templates and document-type configuration are `admin.company.manage` (§3.6.4).
  await grantAdmin(api, s);
  await seedAccount(api.db, s, { code: "1300", nameEn: "Inventory control", type: "asset" });
  await seedAccount(api.db, s, { code: "5110", nameEn: "Stock-count variance", type: "expense" });
  await seedAccount(api.db, s, {
    code: "2150",
    nameEn: "Goods received not invoiced",
    type: "liability",
  });
  await seedDocumentType(api.db, s, {
    code: "STOCK_COUNT",
    module: "inventory",
    policy: STOCK_COUNT_POLICY,
  });
  const grnType = await seedDocumentType(api.db, s, {
    code: "GOODS_RECEIPT",
    module: "inventory",
    policy: GRN_POLICY,
  });
  partyId = await seedParty(api.db, s, { code: "SUP-API", kind: "vendor" });
  warehouseId = await seedWarehouse(api.db, s, { code: "WH-API", kind: "stock", branchId: s.hq });
  unitId = await seedUnit(api.db, s, { code: "PCS" });
  ({ itemId } = await seedItem(api.db, s, {
    code: "SKU-API",
    trackLots: false,
    baseUnitId: unitId,
  }));

  // The two principals and the DISJOINT grants that make R1 non-vacuous through the API as well as through
  // the service: the counter may draft, the checker may approve, neither may do the other's job. The
  // checker also reads the ledger, prints and reverses, which is what test 15's report, print and reversal
  // clauses need — `POST …/reverse` is gated by `accounting.document.reverse` (2B), not by the type's codes.
  counter = await secondPrincipal(api.db, s, "api-counter");
  checker = await secondPrincipal(api.db, s, "api-checker");
  await grantCodes(api.db, s, {
    codes: ["inventory.count.create", "inventory.stock.read"],
    principalId: counter,
    roleCode: "api-counter",
  });
  await grantCodes(api.db, s, {
    codes: [
      "inventory.adjustment.approve",
      "inventory.stock.read",
      "accounting.ledger.read",
      "accounting.document.reverse",
    ],
    principalId: checker,
    roleCode: "api-checker",
  });
  await grantCodes(api.db, s, {
    codes: ["inventory.receipt.post", "inventory.receipt.create"],
  });
  await api.loadPrincipals();

  // 10 units at 4.0000, so there is something to count.
  const { documentId } = await draftTypedDocument(api.db, s, {
    documentTypeId: grnType,
    series: "GRN",
    effectiveDate: "2026-01-05",
    partyId,
    warehouseId,
    lines: [
      {
        kind: "item",
        itemId,
        warehouseId,
        unitId,
        quantity: "10.000000",
        unitPrice: "4.0000",
        amount: "40.0000",
      },
    ],
  });
  await withTenant(
    api.db.rw,
    { tenantId: s.tenant, actorId: s.human, requestId: "api-count-fixture" },
    (tx) =>
      postDocument(
        tx,
        { tenantId: s.tenant, actorId: s.human, requestId: "api-count-fixture" },
        { documentId },
      ),
  );

  // Sheet 1: drafted through the route and left a draft, with one count entered.
  const draftSheet = await postSheet("api-sheet-1", "2026-02-01");
  sheetId = draftSheet.documentId;
  expect(
    (await patchCounts(sheetId, draftSheet.lines[0]!.documentLineId, "9.000000", "api-counts-1"))
      .status,
  ).toBe(200);

  // Sheet 2: drafted and SUBMITTED, so `recordCounts` must refuse it.
  const submitted = await postSheet("api-sheet-2", "2026-02-02");
  submittedSheetId = submitted.documentId;
  submittedLineId = submitted.lines[0]!.documentLineId;
  expect((await transition(submittedSheetId, "submitted", counter, "api-submit-2")).status).toBe(
    200,
  );
}, 360_000);

afterAll(async () => {
  await closeChromium();
  await api.stop();
});

describe("stock-count routes and acceptance test 31's API path (3D T8)", () => {
  it("test 31 by API: the counter cannot approve their own sheet (ERR_SOD_MAKER_IS_CHECKER)", async () => {
    // The sheet is drafted and submitted through the two routes above, so this case exercises the whole
    // API path rather than reaching into the service: POST count-sheet -> PATCH counts -> POST transitions.
    // The submitter here holds BOTH the count and the approve code. With `counter`'s create-only grant the
    // route's pre-flight gate answers 403 before the status trigger runs, so R1 would never be what refused
    // — spec:2449's rule is that a submitter who MAY approve still cannot approve their own sheet.
    const maker = await secondPrincipal(api.db, s, "api-maker-checker");
    await grantCodes(api.db, s, {
      codes: ["inventory.count.create", "inventory.adjustment.approve", "inventory.stock.read"],
      principalId: maker,
      roleCode: "api-maker-checker",
    });
    await api.loadPrincipals();
    const sheet = CountSheetResultSchema.parse(
      await (
        await api.request({
          method: "POST",
          path: `${docs()}/count-sheet`,
          as: maker,
          idempotencyKey: "sod-sheet",
          body: {
            documentTypeCode: "STOCK_COUNT",
            series: "SC",
            effectiveDate: "2026-02-15",
            warehouseId,
          },
        })
      ).json(),
    );
    expect(
      (
        await api.request({
          method: "PATCH",
          path: `${docs()}/${sheet.documentId}/counts`,
          as: maker,
          idempotencyKey: "sod-counts",
          body: {
            counts: [
              { documentLineId: sheet.lines[0]!.documentLineId, countedQuantity: "9.000000" },
            ],
          },
        })
      ).status,
    ).toBe(200);
    expect((await transition(sheet.documentId, "submitted", maker, "sod-submit")).status).toBe(200);
    const res = await transition(sheet.documentId, "approved", maker, "sod-api");
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_SOD_MAKER_IS_CHECKER");
  });

  it("the sheet the COUNTER drew carries no expected quantity, at the moment it is drawn", async () => {
    // The control is on the SNAPSHOT response as well as the read-back: a sheet handed to the counter with
    // the expected figure on it would be confirmed rather than counted, and a control that covers only the
    // second call is not a control.
    const drawn = await postSheet("draw-blind", "2026-02-25");
    expect(drawn.lines.every((l) => l.expectedQuantity === null)).toBe(true);
  });

  it("the count sheet a COUNTER reads carries no expected quantity (the runbook's one control)", async () => {
    const res = await api.request({
      method: "GET",
      path: `${docs()}/${sheetId}/count-sheet`,
      as: counter,
    });
    expect(res.status).toBe(200);
    const body = CountSheetResultSchema.parse(await res.json());
    expect(body.lines).not.toHaveLength(0);
    expect(body.lines.every((l) => l.expectedQuantity === null)).toBe(true);
    // …but the counted figure is the counter's own work and stays visible. Its variance does not: it is
    // `counted − expected`, so it would hand the counter the expected figure (API-12).
    expect(body.lines[0]!.countedQuantity).toBe("9.000000");
    expect(body.lines[0]!.variance).toBeNull();
  });

  it("the same sheet read by an APPROVER carries the expected quantity", async () => {
    const res = await api.request({
      method: "GET",
      path: `${docs()}/${sheetId}/count-sheet`,
      as: checker,
    });
    expect(res.status).toBe(200);
    const body = CountSheetResultSchema.parse(await res.json());
    expect(body.lines[0]!.expectedQuantity).toBe("10.000000");
  });

  it("PATCH …/counts on a submitted sheet is 409 ERR_DOC_STATUS_ILLEGAL", async () => {
    const res = await patchCounts(submittedSheetId, submittedLineId, "1.000000", "late-count");
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_STATUS_ILLEGAL");
  });

  it("POST …/count-sheet without an Idempotency-Key is 400, and without the code is 403", async () => {
    const noKey = await api.request({
      method: "POST",
      path: `${docs()}/count-sheet`,
      as: counter,
      idempotencyKey: null, // the helper omits the header entirely
      body: {
        documentTypeCode: "STOCK_COUNT",
        series: "SC",
        effectiveDate: "2026-02-20",
        warehouseId,
      },
    });
    expect(noKey.status).toBe(400);
    expect((await problemOf(noKey)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");

    const wrongPrincipal = await api.request({
      method: "POST",
      path: `${docs()}/count-sheet`,
      as: checker, // the checker holds `approve`, never `create`
      idempotencyKey: "sheet-403",
      body: {
        documentTypeCode: "STOCK_COUNT",
        series: "SC",
        effectiveDate: "2026-02-20",
        warehouseId,
      },
    });
    expect(wrongPrincipal.status).toBe(403);
    expect((await problemOf(wrongPrincipal)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("a warehouse of another company is 404, never another company's sheet", async () => {
    const other = await seedTenantV2(api.db, "count-api-other");
    await grantCodes(api.db, other);
    const otherWarehouse = await seedWarehouse(api.db, other, {
      code: "WH-OTHER",
      kind: "stock",
      branchId: other.hq,
    });
    const res = await api.request({
      method: "POST",
      path: `${docs()}/count-sheet`,
      as: counter,
      idempotencyKey: "sheet-cross-company",
      body: {
        documentTypeCode: "STOCK_COUNT",
        series: "SC",
        effectiveDate: "2026-02-21",
        warehouseId: otherWarehouse,
      },
    });
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("ERR_NOT_FOUND");
  });
});

describe("acceptance test 15 — a new inventory document type, zero code (spec:2433)", () => {
  let countTestId: string;
  let postedId: string;

  beforeAll(async () => {
    // The whole of "adding a document type": two HTTP calls and no TypeScript, no seed file, no INSERT.
    const created = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/document-types`,
      as: s.human,
      body: {
        code: "COUNT_TEST",
        nameEn: "Count (test type)",
        nameAr: "جرد (نوع اختباري)",
        module: "inventory",
      },
    });
    expect(created.status).toBe(201);
    countTestId = ((await created.json()) as { id: string }).id;
    const versioned = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/document-types/${countTestId}/policies`,
      as: s.human,
      body: { version: 1, effectiveFrom: "2026-01-01", definition: COUNT_TEST_POLICY },
    });
    expect(versioned.status).toBe(201);

    // A print template for the new type, also through the API (2C's route, `admin.company.manage`).
    const template = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/print-templates`,
      as: s.human,
      body: {
        documentTypeCode: "COUNT_TEST",
        code: "standard",
        version: 1,
        nameEn: "Count sheet",
        nameAr: "كشف الجرد",
        engine: "chromium",
        paper: "A4",
        labels: {
          en: { title: "Count", number: "Number" },
          ar: { title: "جرد", number: "رقم" },
        },
        body: [
          '<!doctype html><html lang="{{ lang }}" dir="{{ dir }}"><head><meta charset="utf-8"></head><body>',
          "<h1>{{ labels.title }}</h1>",
          "<p>{{ labels.number }}: {{ document.series }}-{{ document.number }}</p>",
          "</body></html>",
        ].join(""),
      },
    });
    expect(template.status).toBe(201);
  }, 180_000);

  it("COUNT_TEST is not in the seed pack — the zero-code claim is about a type the release did not ship", () => {
    expect(existsSync(join(TYPES_DIR, "COUNT_TEST.json"))).toBe(false);
    expect(existsSync(join(TYPES_DIR, "STOCK_COUNT.json"))).toBe(true);
  });

  it("NUMBERS, and POSTS ONLY THE VARIANCE, through the very same routes", async () => {
    const sheet = await postSheet("ct-sheet", "2026-03-01", "COUNT_TEST");
    expect(sheet.lines).toHaveLength(1);
    // The counter never sees the expected figure — not even on the sheet they just drew — so the count is
    // entered blind, which is the point. Nothing before this case has posted a variance, so the fixture's
    // 10 units are still there and a count of 9 is a shortfall of 1.
    expect(sheet.lines[0]!.expectedQuantity).toBeNull();
    expect(
      (await patchCounts(sheet.documentId, sheet.lines[0]!.documentLineId, "9.000000", "ct-counts"))
        .status,
    ).toBe(200);

    expect((await transition(sheet.documentId, "submitted", counter, "ct-submit")).status).toBe(
      200,
    );
    expect((await transition(sheet.documentId, "approved", checker, "ct-approve")).status).toBe(
      200,
    );
    expect((await transition(sheet.documentId, "issued", checker, "ct-issue")).status).toBe(200);
    expect((await transition(sheet.documentId, "posted", checker, "ct-post")).status).toBe(200);
    postedId = sheet.documentId;

    const read = await api.request({
      method: "GET",
      path: `${docs()}/${postedId}`,
      as: checker,
    });
    const doc = (await read.json()) as { series: string; number: string | null; status: string };
    expect([doc.series, doc.number, doc.status]).toEqual(["CT", "1", "posted"]);

    // Only the varying line moved: one movement, and the untouched lines contributed nothing.
    const movements = await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "ct-movements" },
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.inventory_movement where document_id = ${postedId}`,
    );
    expect(movements[0]!.n).toBe(1);
  });

  it("REPORTS: the posted variance reaches 5110 through 1A's ledger-entries read", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${s.company}/ledger-entries?documentId=${postedId}`,
      as: checker,
    });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: { accountId: string; debit: string; credit: string }[];
    };
    expect(items).toHaveLength(2);
    const codes = await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "ct-codes" },
      (tx) => tx<{ code: string }[]>`
        select a.code from app.ledger_entry e join app.account a on a.id = e.account_id
         where e.document_id = ${postedId} order by a.code`,
    );
    expect(codes.map((c) => c.code)).toEqual(["1300", "5110"]);
  });

  it("PRINTS: the new type renders a PDF carrying its own number", async () => {
    const res = await api.request({
      method: "POST",
      path: `${docs()}/${postedId}/print`,
      as: checker,
      body: { lang: "en" },
    });
    expect(res.status).toBe(200);
    const text = (await pdfText(new Uint8Array(await res.arrayBuffer()))).join(" ");
    expect(text).toContain("CT-1");
  }, 120_000);

  it("REVERSES: refused for an approval-required type — the mirror cannot go draft → issued (§4.5.1)", async () => {
    // `reverseDocument` drafts the mirror and posts it in the same transaction, and §4.5.1 makes
    // draft → issued legal only when `approval.required = false`. COUNT_TEST, like STOCK_COUNT, requires
    // approval, so the reversal is refused by the status trigger (0022) — the mechanic 8B's amendment A4
    // records for PAYROLL. A mis-count is corrected by counting again: the next sheet's expected figure is
    // the current on-hand, so its variance carries the correction (docs/runbooks/stock-count.md). Whether
    // an approval-required type may be reversed at all is an open owner item (docs/reports/phase-4.md).
    const res = await api.request({
      method: "POST",
      path: `${docs()}/${postedId}/reverse`,
      as: checker,
      idempotencyKey: "ct-reverse",
      body: { effectiveDate: "2026-03-05", reason: "recount" },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_DOC_STATUS_ILLEGAL");
    const [doc] = await withTenant(
      api.db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "ct-net" },
      (tx) =>
        tx<{ status: string }[]>`select status::text from app.document where id = ${postedId}`,
    );
    expect(doc!.status).toBe("posted");
  });
});

/**
 * 2026-11-15 review, API-05 and API-12. ADR 0043's branch-gate pattern (`transferSourceBranch`) applied to the
 * count sheet: the `create` stage is asked at the WAREHOUSE's branch — the branch `snapshotCountSheet`
 * stamps on the sheet — so a counter restricted to that branch draws it, and the expected figure is shown
 * to an approver restricted to the SHEET's branch. The variance is masked wherever the expected figure is,
 * because `counted − expected` gives the expected figure back.
 */
describe("branch-restricted counters and approvers (API-05, API-12)", () => {
  let hqCounter: string;
  let br2Counter: string;
  let hqApprover: string;
  let drawn: { documentId: string; lineId: string };

  beforeAll(async () => {
    const br2 = await seedBranch(api.db, s, { code: "BR2-CNT" });
    hqCounter = await secondPrincipal(api.db, s, "api-hq-counter");
    br2Counter = await secondPrincipal(api.db, s, "api-br2-counter");
    hqApprover = await secondPrincipal(api.db, s, "api-hq-approver");
    await grantCodes(api.db, s, {
      codes: ["inventory.count.create", "inventory.stock.read"],
      principalId: hqCounter,
      roleCode: "api-hq-counter",
      branchIds: [s.hq],
    });
    await grantCodes(api.db, s, {
      codes: ["inventory.count.create", "inventory.stock.read"],
      principalId: br2Counter,
      roleCode: "api-br2-counter",
      branchIds: [br2],
    });
    await grantCodes(api.db, s, {
      codes: ["inventory.adjustment.approve", "inventory.stock.read"],
      principalId: hqApprover,
      roleCode: "api-hq-approver",
      branchIds: [s.hq],
    });
    await api.loadPrincipals();
  }, 120_000);

  const drawAs = (as: string, idempotencyKey: string) =>
    api.request({
      method: "POST",
      path: `${docs()}/count-sheet`,
      as,
      idempotencyKey,
      body: {
        documentTypeCode: "STOCK_COUNT",
        series: "SC",
        effectiveDate: "2026-04-03",
        warehouseId,
      },
    });

  it("API-05: a counter restricted to HQ draws a sheet for an HQ warehouse", async () => {
    const res = await drawAs(hqCounter, "api05-hq");
    expect(res.status).toBe(201);
    const sheet = CountSheetResultSchema.parse(await res.json());
    expect(sheet.lines).not.toHaveLength(0);
    expect(sheet.lines.every((l) => l.expectedQuantity === null)).toBe(true);
    drawn = { documentId: sheet.documentId, lineId: sheet.lines[0]!.documentLineId };
  });

  it("API-05: a counter restricted to another branch cannot steer the gate to HQ's warehouse (403)", async () => {
    const res = await drawAs(br2Counter, "api05-br2");
    expect(res.status).toBe(403);
    expect((await problemOf(res)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("API-12: the counter's PATCH and read-back carry no variance; an approver restricted to the sheet's branch sees both figures", async () => {
    const patched = await api.request({
      method: "PATCH",
      path: `${docs()}/${drawn.documentId}/counts`,
      as: hqCounter,
      idempotencyKey: "api12-count",
      body: { counts: [{ documentLineId: drawn.lineId, countedQuantity: "0.000000" }] },
    });
    expect(patched.status).toBe(200);
    const afterPatch = CountSheetResultSchema.parse(await patched.json());
    expect(afterPatch.lines[0]!.countedQuantity).toBe("0.000000");
    expect(afterPatch.lines[0]!.expectedQuantity).toBeNull();
    expect(afterPatch.lines[0]!.variance).toBeNull();

    const read = await api.request({
      method: "GET",
      path: `${docs()}/${drawn.documentId}/count-sheet`,
      as: hqCounter,
    });
    expect(read.status).toBe(200);
    const blind = CountSheetResultSchema.parse(await read.json());
    expect(blind.lines[0]!.variance).toBeNull();

    const reviewed = await api.request({
      method: "GET",
      path: `${docs()}/${drawn.documentId}/count-sheet`,
      as: hqApprover,
    });
    expect(reviewed.status).toBe(200);
    const open = CountSheetResultSchema.parse(await reviewed.json());
    expect(open.lines[0]!.expectedQuantity).not.toBeNull();
    expect(open.lines[0]!.variance).not.toBeNull();
  });
});
