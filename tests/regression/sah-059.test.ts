import { sourceFiles } from "../support/source";
// tests/regression/sah-059.test.ts
// SAH-059 (H) — `procGetTaxItems` overflows its declared buffer on a normal VAT return (spec:713).
// The failure: truncation at a clause boundary yields "a valid query with the period filter missing", and
// the return silently reports every voucher ever posted. Created by slice 5A.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { createTaxReturn, generateTaxReturn } from "@dulja/db";
import { malaysiaPack, Money, currency } from "@dulja/domain";
import { startDb, type Db } from "@dulja/db/test";
import { postTaxedDocument, taxFixture } from "../invariants/support/tax";

describe("SAH-059 procGetTaxItems overflows its declared buffer on a normal VAT return — 5A", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("a return is bounded by its period even when later periods hold much larger figures", async () => {
    const f = await taxFixture(db, "sah059");
    const ctx = { tenantId: f.s.tenant, actorId: f.s.human, requestId: "sah059" };
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-01-10",
      taxInclusive: false,
      lines: [
        { lineNo: 1, accountId: f.accounts["4000"]!, amount: "1000.0000", taxCode: "SYN-OUT-STD" },
      ],
    });
    // The figure the legacy return would have swept in. If the period filter were lost, S2 reads
    // 110 + 11000 = 11110.0000, which is exactly the "filed-return-level error with no visible symptom".
    await postTaxedDocument(db, f, {
      typeCode: "SALES_INVOICE",
      effectiveDate: "2026-06-15",
      taxInclusive: false,
      lines: [
        {
          lineNo: 1,
          accountId: f.accounts["4000"]!,
          amount: "100000.0000",
          taxCode: "SYN-OUT-STD",
        },
      ],
    });
    const boxes = await withTenant(db.rw, ctx, async (tx) => {
      const d = await createTaxReturn(tx, ctx, {
        companyId: f.s.company,
        regimeId: f.regimeId,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      });
      return (await generateTaxReturn(tx, ctx, d.id)).boxes;
    });
    expect(boxes.find((b) => b.code === "S1")!.amount.toString()).toBe("1000.0000");
    expect(boxes.find((b) => b.code === "S2")!.amount.toString()).toBe("110.0000");
  }, 180_000);

  it("an out-of-window transaction is a refusal, never a silently dropped row", () => {
    // The other direction of the same defect. `buildReturnFrom` is handed rows by the caller's own SQL;
    // if a row outside the window ever reaches it, that is a query bug and it says so rather than
    // filtering the row away, which would hide exactly the fault.
    const ccy = currency("MYR");
    const regime = {
      id: "55555555-5555-7555-8555-555555555555",
      code: "SYNTH-MY-v1",
      jurisdiction: "MY" as const,
      version: 1,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };
    const late = {
      documentId: "66666666-6666-7666-8666-666666666666",
      documentTypeCode: "SALES_INVOICE",
      lineNo: 1,
      taxCodeId: "77777777-7777-7777-8777-777777777777",
      taxCode: "SYN-OUT-STD",
      regimeId: regime.id,
      kind: "output" as const,
      rate: "0.11000000",
      base: Money.of("100.0000", ccy),
      tax: Money.of("11.0000", ccy),
      baseBase: Money.of("100.0000", ccy),
      taxBase: Money.of("11.0000", ccy),
      effectiveDate: "2026-06-15",
      postingSeq: "9",
    };
    expect(() =>
      malaysiaPack.buildReturn({
        regime,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
        transactions: [late],
      }),
    ).toThrow(/is dated 2026-06-15, outside 2026-01-01\.\.2026-01-31/);
  });

  it("the period bounds are parameters of a tagged template — losing one is not expressible", () => {
    // The root cause was string building. `sql.unsafe` has exactly three homes (§3.3, hazard 21) and none
    // is in this slice; `no-sql-concat` (test 27) enforces the general rule and this pins it for the two
    // directories a tax reader will look in.
    const offenders = sourceFiles(["packages/domain/src/tax", "packages/db/src/tax"]).flatMap((f) =>
      f.lines.flatMap((line, i) =>
        /\.unsafe\s*\(|["'`][^"'`]*\b(select|insert|update|delete|where)\b[^"'`]*["'`]\s*\+/i.test(
          line,
        )
          ? [`${f.path}:${i + 1} ${line.trim()}`]
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });
});
