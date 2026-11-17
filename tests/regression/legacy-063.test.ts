import { describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { seedItem, seedUnit } from "@dulja/db/test";
import { sharedDb } from "../support/regression";

describe("LEGACY-063 Unguarded division by BtmSize in six of eight places — 3A", () => {
  it("a zero or negative conversion divisor cannot be stored at all", async () => {
    const { db, rw, a } = await sharedDb();
    const { itemId } = await seedItem(db, a, { code: "LEGACY063" });
    const unitId = await seedUnit(db, a, { code: "LEGACY063-CTN" });
    // The old system divided by BtmSize in six of eight sites with no zero/NULL guard. Here the
    // divisor cannot reach the code: the column is NOT NULL and the CHECK refuses 0.
    for (const [numerator, denominator, constraintName] of [
      [12, 0, "unit_conversion_denominator_check"],
      [0, 1, "unit_conversion_numerator_check"],
      [-12, 1, "unit_conversion_numerator_check"],
    ] as const) {
      await expect(
        withTenant(
          rw,
          { tenantId: a.tenant, actorId: a.human, requestId: "legacy-063" },
          (tx) => tx`
        insert into app.unit_conversion (tenant_id, item_id, unit_id, numerator, denominator)
        values (${a.tenant}, ${itemId}, ${unitId}, ${numerator}, ${denominator})`,
        ),
      ).rejects.toThrow(new RegExp(constraintName));
    }
  });

  it("shelf_life_days, the other divisor-shaped column, is guarded the same way", async () => {
    const { db, rw, a } = await sharedDb();
    const unitId = await seedUnit(db, a, { code: "LEGACY063-U2" });
    await expect(
      withTenant(
        rw,
        { tenantId: a.tenant, actorId: a.human, requestId: "legacy-063" },
        (tx) => tx`
      insert into app.item (tenant_id, company_id, code, name_en, kind, base_unit_id, shelf_life_days)
      values (${a.tenant}, ${a.company}, 'LEGACY063-ZERO', 'Zero shelf life', 'product', ${unitId}, 0)`,
      ),
    ).rejects.toThrow(/item_shelf_life_days_check/);
  });
});
