import { linkFulfilment, replaceUnitConversions, transitionDocument } from "@dulja/db";
import {
  draftTypedDocument,
  grantCodes,
  seedDocumentType,
  seedItem,
  seedParty,
  seedTenantV2,
  seedUnit,
  seedWarehouse,
} from "@dulja/db/test";
import { rationalOf } from "@dulja/importer";
import { sliceRegression } from "../support/regression";

sliceRegression(
  "LEGACY-066",
  "Unit conversion is defined in the schema and applied nowhere",
  "3A",
  "the conversion is applied by a TRIGGER, so no write path can skip it (contracts §4.3.4, spec:2043)",
  async ({ db, expect }) => {
    const [trigger] = await db.admin<{ tgname: string; enabled: string }[]>`
      select t.tgname, t.tgenabled as enabled
        from pg_trigger t
       where t.tgrelid = 'app.document_line'::regclass
         and t.tgname = 'document_line_base_quantity'`;
    // The old system stored MatUnits.Exchange and never multiplied by it: the conversion existed as data
    // and as documentation, and each of five call sites decided for itself. Here the only place the
    // arithmetic happens on a write is inside the database, which is what makes "every write path" true
    // rather than "every write path we remembered".
    expect(trigger?.tgname).toBe("document_line_base_quantity");
    expect(trigger?.enabled).toBe("O"); // enabled, ORIGIN — never disabled "temporarily" (spec:97)
  },
);

sliceRegression(
  "LEGACY-066",
  "Unit conversion is defined in the schema and applied nowhere",
  "3A",
  "the conversion is an exact rational in the schema, not a float (first proven by packages/db/test/inventory/unit-conversion.test.ts)",
  async ({ db, expect }) => {
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'unit_conversion'
         and column_name in ('numerator', 'denominator')
       order by column_name`;
    expect(cols).toEqual([
      { column_name: "denominator", data_type: "bigint" },
      { column_name: "numerator", data_type: "bigint" },
    ]);
  },
);

sliceRegression(
  "LEGACY-066",
  "Unit conversion is defined in the schema and applied nowhere",
  "9B",
  "a legacy MatUnits.Exchange float crosses the importer's boundary as an exact Rational, never a number, never Money, and never a silent 1",
  async ({ expect }) => {
    expect(rationalOf({ EXCHANGE: "12.5" }, "EXCHANGE", "MATUNITS/1")).toEqual({
      numerator: 25n,
      denominator: 2n,
    });
    // The float the source stored, exactly — not the 1/3 a person meant, which would be a guess.
    expect(rationalOf({ EXCHANGE: "0.333333" }, "EXCHANGE", "MATUNITS/2")).toEqual({
      numerator: 333333n,
      denominator: 1000000n,
    });
    // "nothing rejects Exchange = 0 or NULL" (spec LEGACY-066): here both are refused, by name.
    expect(() => rationalOf({ EXCHANGE: "0" }, "EXCHANGE", "MATUNITS/3")).toThrow(
      /^ERR_VALIDATION_FAILED: MATUNITS\/3: EXCHANGE is 0; a unit conversion factor must be positive \(LEGACY-066\)$/,
    );
    expect(() => rationalOf({ EXCHANGE: null }, "EXCHANGE", "MATUNITS/4")).toThrow(
      /a missing conversion factor is never read as 1 \(LEGACY-066\)/,
    );
  },
);

sliceRegression(
  "LEGACY-066",
  "Unit conversion is defined in the schema and applied nowhere",
  "review 2026-11-15 (MON-02)",
  "a price is per ENTERED unit: a carton line priced from its order is valued in cartons, never in base pieces (first proven by packages/db/test/ar-ap/entered-unit-price.test.ts)",
  async ({ db, withTenant, expect }) => {
    // The legacy system kept the entry quantity and the base quantity apart and converted between them
    // nowhere. Here the base quantity is derived (0032), and the second half of the rule is that a price
    // is never extended over the WRONG one of the two: 2 CTN of 12 at 30.0000 a carton is 60.0000, and
    // the defect billed 720.0000 — the price per carton times the pieces.
    const s = await seedTenantV2(db, "LEGACY-066-entered-unit");
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    const type = (code: string, series: string) =>
      seedDocumentType(db, s, {
        code,
        module: "inventory",
        policy: {
          version: 1,
          documentType: code,
          direction: "none",
          requires: [],
          lines: [],
          inventory: { effect: "none" },
          tax: { applies: false },
          numbering: { series, assignAt: "issue" },
          reversal: { allowed: false, producesType: null },
          approval: { required: false, approve: null, post: "accounting.journal.post" },
          fxRoundingAccount: { from: "company.fx_rounding_account_id" },
          dimensions: { required: [] },
        },
      });
    const orderType = await type("LEGACY066_ORDER", "SO66");
    const receiptType = await type("LEGACY066_RECEIPT", "SR66");
    const { itemId } = await seedItem(db, s, { code: "LEGACY066-IT", trackLots: false });
    const ctn = await seedUnit(db, s, { code: "CTN" });
    const ctx = { tenantId: s.tenant, actorId: s.human, requestId: "legacy-066-entered-unit" };
    await withTenant(db.rw, ctx, (tx) =>
      replaceUnitConversions(tx, itemId, [{ unitId: ctn, numerator: "12", denominator: "1" }]),
    );
    const partyId = await seedParty(db, s, { kind: "vendor", code: "LEGACY066-V" });
    const warehouseId = await seedWarehouse(db, s, { code: "LEGACY066-WH" });
    const carton = { kind: "item" as const, itemId, unitId: ctn, unitQuantity: "2.000000" };
    const order = await draftTypedDocument(db, s, {
      documentTypeId: orderType,
      series: "SO66",
      partyId,
      lines: [{ ...carton, quantity: "24.000000", unitPrice: "30.0000", amount: "60.0000" }],
    });
    const receipt = await draftTypedDocument(db, s, {
      documentTypeId: receiptType,
      series: "SR66",
      partyId,
      warehouseId,
      lines: [{ ...carton, warehouseId, quantity: "24.000000" }],
    });
    await withTenant(db.rw, ctx, async (tx) => {
      await transitionDocument(tx, ctx, { documentId: order.documentId, to: "issued" });
      await linkFulfilment(tx, ctx, {
        sourceDocumentId: order.documentId,
        targetDocumentId: receipt.documentId,
        linkKind: "receives_against",
        lines: [
          {
            sourceLineId: order.lineIds[0]!,
            targetLineId: receipt.lineIds[0]!,
            quantity: "24.000000",
          },
        ],
      });
    });
    const [line] = await db.admin<{ amount: string; unitPrice: string }[]>`
      select amount::text as amount, unit_price::text as "unitPrice"
        from app.document_line where id = ${receipt.lineIds[0]!}`;
    expect(line).toEqual({ amount: "60.0000", unitPrice: "30.0000" });
  },
);
