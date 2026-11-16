import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative imports, never `@dulja/db*` and never `@dulja/contracts`: 0B's `dependency-rule` keys the owner
// on the path prefix `packages/db/`, so `test/**` is in its scope too and `@dulja/domain` is the only
// package specifier any file under this package may name (0b:5052, 0b:5091). The one ALLOW entry is
// `permission-catalogue.test.ts`. The permission catalogue therefore arrives here as DATA, read from
// `app.permission` — global, RLS-free, written only by migration 0014 and its successors, and pinned equal
// to `PERMISSIONS` in both directions by that suite.
import { linkFulfilment, openQuantity, postDocument, transitionDocument } from "../../src/index";
import { documentTypesLoader } from "../../src/seed/index";
// `openQuantity`, `linkFulfilment` and `seedWarehouse` arrived with Task 6: the two open-quantity cases
// that need them also need `GOODS_RECEIPT`, which Task 6 seeds, so Task 6 Step 5 appended those cases and
// these three names together. An import this file does not use fails `bun run lint` (Global Constraint 16).
import {
  draftTypedDocument,
  grantCodes,
  seedItem,
  seedParty,
  seedTenantV2,
  seedWarehouse,
  startDb,
  withTenant,
  type Db,
  type Seed,
} from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");

let db: Db;
let s: Seed;
let catalogue: string[];

const ctx = (seed: Seed) => ({
  tenantId: seed.tenant,
  actorId: seed.human,
  requestId: "3c-po-test",
});

/** Hoisted out of the describe block (oxlint unicorn/consistent-function-scoping): it closes over the
 *  module-level `db` and `s`, not over anything the describe introduces. */
async function typeId(code: string): Promise<string> {
  const [row] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) => tx<{ id: string }[]>`
    select id from app.document_type where company_id = ${s.company} and code = ${code}`,
  );
  return row!.id;
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "po");
  catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
    (row) => row.code,
  );
  await grantCodes(db, s, {
    codes: ["accounting.purchase.create", "inventory.receipt.create", "inventory.receipt.post"],
  });
  await withTenant(db.migrator, s.tenant, s.system, (tx) =>
    documentTypesLoader.load(tx, {
      config: {
        tenantId: s.tenant,
        only: ["document-types"],
        packRoot: PACK_ROOT,
        appEnv: "dev" as const,
        tenantName: "po",
        ownerEmail: "owner@example.invalid",
        companyCode: "HQ",
        companyName: "po HQ",
        baseCurrency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
        fiscalYearStartMonth: 1,
        fiscalYear: 2026,
      },
      tenantId: s.tenant,
      companyId: s.company,
      systemPrincipalId: s.system,
      packRoot: PACK_ROOT,
    }),
  );
}, 240_000);
afterAll(async () => {
  await db.stop();
});

describe("PURCHASE_ORDER — contracts §4.14, spec:1050", () => {
  it("the seed file is a valid §4.3.7 envelope with module inventory and series PO", () => {
    const envelope = JSON.parse(
      readFileSync(join(TYPES_DIR, "PURCHASE_ORDER.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(validateDocumentTypeSeed(envelope)).toEqual({ ok: true, errors: [] });
    expect(envelope["code"]).toBe("PURCHASE_ORDER");
    expect(envelope["module"]).toBe("inventory");
    const policy = envelope["policy"] as Record<string, unknown>;
    expect(policy["direction"]).toBe("none");
    expect(policy["inventory"]).toEqual({ effect: "none" });
    expect(policy["lines"]).toEqual([]);
    expect(policy["numbering"]).toEqual({ series: "PO", assignAt: "issue" });
    expect(policy["approval"]).toEqual({
      required: false,
      approve: null,
      post: "accounting.purchase.create",
    });
    expect(policy["reversal"]).toEqual({ allowed: false, producesType: null });
  });

  it("every approval code the policy names is in the catalogue (F-21)", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "PURCHASE_ORDER.json"), "utf8")) as {
      policy: { approval: Record<string, string | null> };
    };
    // `validatePolicy` IS the F-21 rule — the schema plus "every approval code exists in the catalogue".
    // The loop below pins the same fact one code at a time, so a failure names the code rather than a path.
    expect(validatePolicy(envelope.policy, catalogue)).toEqual({ ok: true, errors: [] });
    for (const named of Object.values(envelope.policy.approval)) {
      if (typeof named === "string") expect(catalogue).toContain(named);
    }
  });

  it("issues, takes a PO number, and never posts (ERR_DOC_NO_LINES by design)", async () => {
    const documentTypeId = await typeId("PURCHASE_ORDER");
    const partyId = await seedParty(db, s, { kind: "vendor", code: "PO-VEND" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PO-ITEM" });
    const { documentId } = await draftTypedDocument(db, s, {
      documentTypeId,
      series: "PO",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "250.000000",
          unitPrice: "4.0000",
          amount: "1000.0000",
        },
      ],
    });

    const issued = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctx(s), { documentId, to: "issued" }),
    );
    expect(issued).toMatchObject({ from: "draft", to: "issued" });
    expect(issued.number).toBe(1n);

    const [header] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ series: string; status: string; number: string }[]>`
      select series, status::text as status, number::text as number
        from app.document where id = ${documentId}`,
    );
    expect(header).toEqual({ series: "PO", status: "issued", number: "1" });

    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) => postDocument(tx, ctx(s), { documentId })),
    ).rejects.toMatchObject({ code: "ERR_DOC_NO_LINES" });

    // Nothing reached the ledger or the movements.
    const [counts] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ ledger: number; movements: number }[]>`
      select (select count(*)::int from app.ledger_entry where document_id = ${documentId}) as ledger,
             (select count(*)::int from app.inventory_movement where document_id = ${documentId}) as movements`,
    );
    expect(counts).toEqual({ ledger: 0, movements: 0 });
  });

  // The two cases Task 5 deferred. Neither POSTS anything — an order never posts, and a receipt is only
  // *linked* here — so neither waits for Task 8's receipt-value site.
  it("open quantity starts at the ordered quantity and falls as fulfilments are linked (spec:1050)", async () => {
    const orderTypeId = await typeId("PURCHASE_ORDER");
    const receiptTypeId = await typeId("GOODS_RECEIPT");
    const partyId = await seedParty(db, s, { kind: "vendor", code: "PO-VEND-2" });
    const warehouseId = await seedWarehouse(db, s, { code: "PO-WH" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PO-ITEM-2" });

    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderTypeId,
      series: "PO",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "100.000000",
          unitPrice: "7.5000",
          amount: "750.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctx(s), { documentId: order.documentId, to: "issued" }),
    );

    const before = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openQuantity(tx, order.documentId),
    );
    expect(before).toEqual([
      {
        documentId: order.documentId,
        documentLineId: order.lineIds[0],
        lineNo: 1,
        itemId,
        orderedQuantity: "100.000000",
        linkedQuantity: "0.000000",
        openQuantity: "100.000000",
      },
    ]);

    // Two part receipts: 60 then 40. The back-order stays open in between.
    for (const qty of ["60.000000", "40.000000"]) {
      const receipt = await draftTypedDocument(db, s, {
        documentTypeId: receiptTypeId,
        series: "GRN",
        partyId,
        warehouseId,
        lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: qty }],
      });
      await withTenant(db.rw, s.tenant, s.human, (tx) =>
        linkFulfilment(tx, ctx(s), {
          sourceDocumentId: order.documentId,
          targetDocumentId: receipt.documentId,
          linkKind: "receives_against",
          lines: [
            { sourceLineId: order.lineIds[0]!, targetLineId: receipt.lineIds[0]!, quantity: qty },
          ],
        }),
      );
      const linked = await withTenant(db.rw, s.tenant, s.human, (tx) =>
        openQuantity(tx, order.documentId),
      );
      expect(linked[0]!.linkedQuantity).toBe(qty === "60.000000" ? "60.000000" : "100.000000");
    }
    const after = await withTenant(db.rw, s.tenant, s.human, (tx) =>
      openQuantity(tx, order.documentId),
    );
    expect(after[0]!.openQuantity).toBe("0.000000");
  });

  it("a third receipt against a fully received order is refused (ERR_DOC_LINK_OVER_FULFILLED)", async () => {
    const orderTypeId = await typeId("PURCHASE_ORDER");
    const receiptTypeId = await typeId("GOODS_RECEIPT");
    const partyId = await seedParty(db, s, { kind: "vendor", code: "PO-VEND-3" });
    const warehouseId = await seedWarehouse(db, s, { code: "PO-WH-3" });
    const { itemId, baseUnitId } = await seedItem(db, s, { code: "PO-ITEM-3" });
    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderTypeId,
      series: "PO",
      partyId,
      lines: [
        {
          kind: "item",
          itemId,
          unitId: baseUnitId,
          quantity: "5.000000",
          unitPrice: "1.0000",
          amount: "5.0000",
        },
      ],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      transitionDocument(tx, ctx(s), { documentId: order.documentId, to: "issued" }),
    );
    const r1 = await draftTypedDocument(db, s, {
      documentTypeId: receiptTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "5.000000" }],
    });
    await withTenant(db.rw, s.tenant, s.human, (tx) =>
      linkFulfilment(tx, ctx(s), {
        sourceDocumentId: order.documentId,
        targetDocumentId: r1.documentId,
        linkKind: "receives_against",
        lines: [
          { sourceLineId: order.lineIds[0]!, targetLineId: r1.lineIds[0]!, quantity: "5.000000" },
        ],
      }),
    );
    const r2 = await draftTypedDocument(db, s, {
      documentTypeId: receiptTypeId,
      series: "GRN",
      partyId,
      warehouseId,
      lines: [{ kind: "item", itemId, unitId: baseUnitId, warehouseId, quantity: "1.000000" }],
    });
    await expect(
      withTenant(db.rw, s.tenant, s.human, (tx) =>
        linkFulfilment(tx, ctx(s), {
          sourceDocumentId: order.documentId,
          targetDocumentId: r2.documentId,
          linkKind: "receives_against",
          lines: [
            { sourceLineId: order.lineIds[0]!, targetLineId: r2.lineIds[0]!, quantity: "1.000000" },
          ],
        }),
      ),
    ).rejects.toThrow(/ERR_DOC_LINK_OVER_FULFILLED/);
  });
});
