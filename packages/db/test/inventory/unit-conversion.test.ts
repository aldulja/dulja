import { grantCodes } from "../fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Quantity } from "@dulja/domain";
import { UnitConversionMissingError } from "../../src/inventory/errors"; // Task 1's module — one declaration
import {
  convertToBase,
  listUnitConversions,
  replaceUnitConversions,
  resolveUnitConversion,
} from "../../src/inventory/units";
import { draftDocument, seedItem, seedTenant, seedUnit, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

describe("unit conversion applied by the data layer — migration 0032 (LEGACY-066, ADR 0036)", () => {
  let db: Db;
  let a: Seed;
  let itemId: string;
  let pieceId: string;
  let cartonId: string;
  let innerId: string;
  let tieId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Conv A");
    await grantCodes(db, a); // 6C: explicit company-wide branch visibility; no permission codes.
    ({ itemId, baseUnitId: pieceId } = await seedItem(db, a, { code: "RICE-5KG" }));
    cartonId = await seedUnit(db, a, { code: "CTN", nameEn: "Carton" });
    innerId = await seedUnit(db, a, { code: "INR", nameEn: "Inner" });
    tieId = await seedUnit(db, a, { code: "TIE", nameEn: "Tie unit" });
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      replaceUnitConversions(tx, itemId, [
        { unitId: cartonId, numerator: "12", denominator: "1" }, // 1 carton = 12 pieces
        { unitId: innerId, numerator: "1", denominator: "4" }, // 1 inner = 1/4 piece
        // 1 TIE = 1/2000000 piece: one unit converts to exactly 0.0000005, a tie at QUANTITY_SCALE. It
        // exists only so the rounding-mode agreement between TypeScript and the trigger is asserted and
        // not assumed.
        { unitId: tieId, numerator: "1", denominator: "2000000" },
      ]),
    );
  });
  afterAll(async () => {
    await db.stop();
  });

  it("resolveUnitConversion returns the item's own rational, and the identity for the base unit", async () => {
    const carton = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveUnitConversion(tx, { itemId, unitId: cartonId }),
    );
    expect(carton).toEqual({ numerator: 12n, denominator: 1n });
    const base = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      resolveUnitConversion(tx, { itemId, unitId: pieceId }),
    );
    expect(base).toEqual({ numerator: 1n, denominator: 1n }); // no row needed for the base unit
  });

  it("an unconfigured unit is named, never silently treated as the base unit", async () => {
    const stray = await seedUnit(db, a, { code: "PLT", nameEn: "Pallet" });
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        resolveUnitConversion(tx, { itemId, unitId: stray }),
      ),
    ).rejects.toThrow(UnitConversionMissingError);
    await expect(
      withTenant(db.rw, a.tenant, a.human, (tx) =>
        resolveUnitConversion(tx, { itemId, unitId: stray }),
      ),
    ).rejects.toThrow(new RegExp(`no unit conversion for item ${itemId} and unit ${stray}`));
  });

  it("convertToBase multiplies exactly and returns a Quantity, never a number", async () => {
    const q = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      convertToBase(tx, { itemId, unitId: cartonId, unitQuantity: Quantity.of("2.500000") }),
    );
    expect(q.toString()).toBe("30.000000");
  });

  it("replaceUnitConversions is idempotent and re-prices an existing pair rather than duplicating it", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      replaceUnitConversions(tx, itemId, [
        { unitId: cartonId, numerator: "24", denominator: "1" },
        { unitId: innerId, numerator: "1", denominator: "4" },
      ]),
    );
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      listUnitConversions(tx, itemId),
    );
    // TIE is omitted from the payload and therefore LEFT STANDING — the documented behaviour of
    // `replaceUnitConversions`, asserted here rather than only described in its docstring.
    expect(rows.map((r) => `${r.unitCode}=${r.numerator}/${r.denominator}`).toSorted()).toEqual([
      "CTN=24/1",
      "INR=1/4",
      "TIE=1/2000000",
    ]);
  });

  it("convertToBase and the 0032 trigger agree at a rounding TIE — one mode, both sides", async () => {
    // The only assertion that actually proves the read-side twin is a twin. 1 TIE = 1/2000000 piece, so
    // the exact answer is 0.0000005 and the answer depends entirely on the mode: HALF_AWAY_FROM_ZERO
    // (Postgres round(), and applyConversion) gives 0.000001; HALF_EVEN (Quantity.convert) gives
    // 0.000000. If they ever diverge, the insert below fails with
    // `ERR_VALIDATION_FAILED: line 1 says 0.000000 base units but 1.000000 of that unit is 0.000001`,
    // which is precisely the false refusal an API caller would hit.
    // Two entered quantities, because one pins the MODE and the pair pins the ORDER: 1 → 0.0000005 and
    // 3 → 0.0000015 are both ties, and only "multiply by the numerator, then divide, then round once"
    // gives 0.000001 and 0.000002 on both sides. A twin that collapsed the rational to a decimal before
    // multiplying (what `Quantity.multiply(rational, mode)` does) is what the second row would catch.
    const doc = await draftDocument(db, a);
    let lineNo = 0;
    for (const [entered, expected] of [
      ["1.000000", "0.000001"],
      ["3.000000", "0.000002"],
    ] as const) {
      const previewed = await withTenant(db.rw, a.tenant, a.human, (tx) =>
        convertToBase(tx, { itemId, unitId: tieId, unitQuantity: Quantity.of(entered) }),
      );
      expect(previewed.toString()).toBe(expected);
      const [line] = await withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx<{ quantity: string }[]>`
          insert into app.document_line
            (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, quantity, amount)
          values (${a.tenant}, ${a.company}, ${doc}, ${++lineNo}, 'item', ${itemId}, ${tieId}, ${entered},
                  ${previewed.toString()}, 1.0000)
          returning quantity::text as quantity`,
      );
      expect(line!.quantity).toBe(expected);
    }
  });

  it("the TRIGGER derives document_line.quantity from the entered pair — every write path (LEGACY-066)", async () => {
    const doc = await draftDocument(db, a);
    const [line] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ quantity: string }[]>`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, amount)
        values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, ${cartonId}, 3.000000, 100.0000)
        returning quantity::text as quantity`,
    );
    expect(line!.quantity).toBe("72.000000"); // 3 cartons × 24 pieces, derived in SQL
  });

  it("a supplied quantity that disagrees with the conversion is refused, not overwritten", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.document_line
            (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, quantity, amount)
          values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, ${cartonId}, 3.000000, 36.000000, 100.0000)`,
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: line 1 says 36.000000 base units but 3.000000 of that unit is 72.000000/,
    );
  });

  it("a line entered directly in base units, with no pair, is left exactly as written", async () => {
    const doc = await draftDocument(db, a);
    const [line] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) => tx<{ quantity: string }[]>`
        insert into app.document_line
          (tenant_id, company_id, document_id, line_no, kind, item_id, quantity, amount)
        values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, 5.500000, 100.0000)
        returning quantity::text as quantity`,
    );
    expect(line!.quantity).toBe("5.500000");
  });

  it("an entered pair whose unit has no conversion is refused at write time", async () => {
    const doc = await draftDocument(db, a);
    const stray = await seedUnit(db, a, { code: "DRM", nameEn: "Drum" });
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.document_line
            (tenant_id, company_id, document_id, line_no, kind, item_id, unit_id, unit_quantity, amount)
          values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${itemId}, ${stray}, 1.000000, 10.0000)`,
      ),
    ).rejects.toThrow(/ERR_VALIDATION_FAILED: no unit conversion for item/);
  });

  it("an entered pair with no item at all is refused before any lookup", async () => {
    const doc = await draftDocument(db, a);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.document_line
            (tenant_id, company_id, document_id, line_no, kind, unit_id, unit_quantity, amount)
          values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${cartonId}, 1.000000, 10.0000)`,
      ),
    ).rejects.toThrow(
      /ERR_VALIDATION_FAILED: line 1 carries a unit and a unit quantity but no item/,
    );
  });

  it("item_id now has a foreign key: an arbitrary uuid is a 23503 (§4.3.4, assumption 10)", async () => {
    const doc = await draftDocument(db, a);
    const stray = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
          insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, item_id, amount)
          values (${a.tenant}, ${a.company}, ${doc}, 1, 'item', ${stray}, 10.0000)`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("document_line carries NO branch_isolation policy and never gains one (§4.5.6)", async () => {
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_policies
       where schemaname = 'app' and tablename = 'document_line' and policyname = 'branch_isolation'`;
    // It has a warehouse_id from this migration, and §3.5.1 step 7 is explicit that a warehouse_id alone
    // does not attract the policy — document_line is isolated through its parent document.
    expect(p!.n).toBe(0);
  });
});
