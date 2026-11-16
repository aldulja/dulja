import { describe, expect, it } from "vitest";
import { DateSchema, PositiveQuantitySchema } from "../src/common";
import { DocumentLineInput } from "../src/accounting/document";
import { SettlementAllocationSchema } from "../src/accounting/settlement";
import { CreatePromotionBody, UpdatePromotionBody } from "../src/inventory/promotion";

describe("positive magnitudes", () => {
  it.each(["0.000000", "00.000000", "000.000000"])("refuses zero quantity %s", (value) => {
    expect(PositiveQuantitySchema.safeParse(value).success).toBe(false);
  });

  it.each(["0.0000", "00.0000", "000.0000"])("refuses zero settlement allocation %s", (amount) => {
    expect(
      SettlementAllocationSchema.safeParse({
        settledDocumentId: "01920000-0000-7000-8000-000000000001",
        amount,
      }).success,
    ).toBe(false);
  });

  it("admits the smallest positive quantity and amount, including leading zeroes", () => {
    expect(PositiveQuantitySchema.safeParse("00.000001").success).toBe(true);
    expect(
      SettlementAllocationSchema.safeParse({
        settledDocumentId: "01920000-0000-7000-8000-000000000001",
        amount: "00.0001",
      }).success,
    ).toBe(true);
  });
});

describe("document line sides", () => {
  it.each([
    { debit: "1.0000", credit: "00.0000" },
    { debit: "000.0000", credit: "1.0000" },
    { debit: "00.0000", credit: "000.0000" },
  ])("admits numeric zero on the unused side: %j", (amounts) => {
    expect(DocumentLineInput.safeParse({ lineNo: 1, kind: "text", ...amounts }).success).toBe(true);
  });

  it("still refuses two positive sides", () => {
    expect(
      DocumentLineInput.safeParse({ lineNo: 1, kind: "text", debit: "00.0001", credit: "00.0001" })
        .success,
    ).toBe(false);
  });
});

describe("dates supported by PostgreSQL", () => {
  it("refuses year zero before it reaches a date column", () => {
    expect(DateSchema.safeParse("0000-01-01").success).toBe(false);
    expect(DateSchema.safeParse("0001-01-01").success).toBe(true);
  });
});

describe("promotion windows compare instants", () => {
  const create = { code: "SALE", nameEn: "Sale", kind: "percent_off", definition: {} };

  it.each([
    ["2026-09-30T12:00:00+08:00", "2026-09-30T05:00:00Z", true],
    ["2026-09-30T12:00:00+08:00", "2026-09-30T11:00:00Z", true],
    ["2026-09-30T12:00:00+08:00", "2026-09-30T13:00:00+10:00", false],
    ["2026-09-30T12:00:00+08:00", "2026-09-30T04:00:00Z", false],
    ["2026-09-30T12:00:00.1Z", "2026-09-30T12:00:00.100Z", false],
    ["2026-09-30T12:00:00.000001Z", "2026-09-30T12:00:00.000002Z", true],
    ["2026-09-30T12:00:00.000002Z", "2026-09-30T12:00:00.000001Z", false],
  ])("validates %s to %s as %s for create and update", (startsAt, endsAt, valid) => {
    expect(CreatePromotionBody.safeParse({ ...create, startsAt, endsAt }).success).toBe(valid);
    expect(UpdatePromotionBody.safeParse({ startsAt, endsAt }).success).toBe(valid);
  });

  it("keeps open-ended and partial windows valid", () => {
    expect(CreatePromotionBody.safeParse(create).success).toBe(true);
    expect(
      UpdatePromotionBody.safeParse({ startsAt: null, endsAt: "2026-09-30T12:00:00Z" }).success,
    ).toBe(true);
    expect(UpdatePromotionBody.safeParse({ startsAt: "2026-09-30T12:00:00Z" }).success).toBe(true);
  });
});
