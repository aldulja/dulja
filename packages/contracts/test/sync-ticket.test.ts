import { describe, expect, it } from "vitest";
import { TicketBatchBody, TicketSchema, BatchResultSchema } from "../src/sync/ticket";
import { TillCashMovementSchema } from "../src/pos/till";
const id = "00000000-0000-7000-8000-000000000001";
const money = { amount: "1.0000", currency: "MYR" };
const ticket = {
  clientRef: id,
  shiftId: id,
  cashierPrincipalId: id,
  customerId: id,
  kind: "sale",
  returnsClientRef: null,
  currency: "MYR",
  soldAt: "2026-10-08T10:00:00Z",
  lines: [
    {
      lineNo: 1,
      itemId: id,
      lotId: null,
      quantity: "1.000000",
      unitId: id,
      unitPrice: money,
      discount: { ...money, amount: "0.0000" },
      taxCodeId: null,
      taxAmount: { ...money, amount: "0.0000" },
      total: money,
    },
  ],
  tenders: [],
  events: [],
  attendance: [],
  catalogueRevision: "9007199254740993",
};
describe("external sync ticket contract", () => {
  it("represents account sales and exact bigint revisions", () => {
    expect(TicketSchema.parse(ticket).catalogueRevision).toBe("9007199254740993");
  });
  it("refuses numeric revisions", () => {
    expect(
      TicketSchema.safeParse({ ...ticket, catalogueRevision: Number.MAX_SAFE_INTEGER + 2 }).success,
    ).toBe(false);
  });
  it("refuses future rounding and wire cost fields", () => {
    expect(TicketSchema.safeParse({ ...ticket, cashRounding: {} }).success).toBe(false);
    expect(
      TicketSchema.safeParse({ ...ticket, lines: [{ ...ticket.lines[0], cost: money }] }).success,
    ).toBe(false);
  });
  it("admits a line's promotion evidence with exactly its two fields (ADR 0059, PR 12 review)", () => {
    const line = ticket.lines[0]!;
    const evidence = { promotionId: id, discount: { ...money, amount: "0.1000" } };
    const withEvidence = (promotion: unknown) =>
      TicketSchema.safeParse({ ...ticket, lines: [{ ...line, promotion }] });
    expect(withEvidence(evidence).success).toBe(true);
    expect(withEvidence(null).success).toBe(true);
    expect(TicketSchema.parse(ticket).lines[0]!.promotion).toBeUndefined();
    expect(withEvidence({ ...evidence, kind: "percent_off" }).success).toBe(false);
    expect(withEvidence({ promotionId: "PROMO10", discount: evidence.discount }).success).toBe(
      false,
    );
    expect(withEvidence({ promotionId: id }).success).toBe(false);
  });
  it("refuses empty batches", () => {
    expect(
      TicketBatchBody.safeParse({
        terminalId: id,
        batchId: id,
        tickets: [],
        shifts: [],
        tillEvents: [],
      }).success,
    ).toBe(false);
  });
  it("refuses a till-computed expectedCash or overShort on a shift message (ADR 0063)", () => {
    const close = {
      shiftId: id,
      kind: "close",
      terminalId: id,
      cashierPrincipalId: id,
      at: "2026-10-08T10:00:00Z",
      currency: "MYR",
      openingFloat: null,
      countedCash: money,
    };
    const batch = (shift: Record<string, unknown>) =>
      TicketBatchBody.safeParse({
        terminalId: id,
        batchId: id,
        tickets: [],
        shifts: [shift],
        tillEvents: [],
      }).success;
    // The count alone is what a till sends, and it is accepted.
    expect(batch(close)).toBe(true);
    // A figure the server derives is refused, not silently stripped: stripping would answer `accepted`.
    expect(batch({ ...close, expectedCash: money })).toBe(false);
    expect(batch({ ...close, overShort: money })).toBe(false);
    expect(batch({ ...close, expectedCash: money, overShort: money })).toBe(false);
  });
  it("⚠️ OD-10: a batch of cash events alone is valid, strict, and optional on a three-array batch", () => {
    const cash = {
      clientRef: id,
      shiftId: id,
      kind: "paid_out",
      amount: money,
      cashierPrincipalId: id,
      supervisorPrincipalId: null,
      occurredAt: "2026-11-04T10:00:00Z",
      reference: "RCPT-1",
      fromSafe: false,
    };
    const body = (cashEvents: unknown[]) =>
      TicketBatchBody.safeParse({
        terminalId: id,
        batchId: id,
        tickets: [],
        shifts: [],
        tillEvents: [],
        cashEvents,
      });
    expect(body([cash]).success).toBe(true);
    expect(body([{ ...cash, expectedCash: money }]).success).toBe(false); // strict, like its siblings
    expect(body([{ ...cash, kind: "float_top_up" }]).success).toBe(false);
    expect(body([]).success).toBe(false); // still "at least one message"
    // A batch from a till that predates the fourth array has no key at all, and is valid.
    expect(
      TicketBatchBody.safeParse({
        terminalId: id,
        batchId: id,
        tickets: [ticket],
        shifts: [],
        tillEvents: [],
      }).success,
    ).toBe(true);
    // A reader of an answer without the fourth array defaults it to [].
    expect(
      BatchResultSchema.parse({
        batchId: id,
        results: [],
        shiftResults: [],
        tillEventResults: [],
        catalogueCursor: "MA",
      }).cashEventResults,
    ).toEqual([]);
  });
  it("⚠️ OD-10: the till's cash movement request needs a paid-out reference and keeps fromSafe to a banking", () => {
    const base = { action: "cash_movement", shiftId: id, amount: "5.0000" };
    expect(
      TillCashMovementSchema.safeParse({ ...base, kind: "paid_out", reference: "R" }).success,
    ).toBe(true);
    expect(TillCashMovementSchema.safeParse({ ...base, kind: "paid_out" }).success).toBe(false);
    expect(
      TillCashMovementSchema.safeParse({ ...base, kind: "banking", fromSafe: true }).success,
    ).toBe(true);
    expect(
      TillCashMovementSchema.safeParse({ ...base, kind: "safe_drop", fromSafe: true }).success,
    ).toBe(false);
    expect(
      TillCashMovementSchema.safeParse({
        ...base,
        kind: "safe_drop",
        approval: { employeeNumber: "S", pin: "1234" },
      }).success,
    ).toBe(false);
  });
  it("keeps outcomes and the opaque catalogue cursor", () => {
    expect(
      BatchResultSchema.parse({
        batchId: id,
        results: [],
        shiftResults: [],
        tillEventResults: [],
        catalogueCursor: "MA",
      }).catalogueCursor,
    ).toBe("MA");
  });
});

describe("a till's quick customer fits the wire (POS-01)", () => {
  it("refuses at the till every code the sync wire would refuse, so no ticket poisons the outbox", async () => {
    const { TillQuickCustomerSchema } = await import("../src/pos/till");
    const { NewCustomerSchema } = await import("../src/sync/ticket");
    for (const length of [1, 40, 41, 45, 64]) {
      const code = "C".repeat(length);
      const till = TillQuickCustomerSchema.safeParse({ nameEn: "Ali", code }).success;
      const wire = NewCustomerSchema.safeParse({ id, code, nameEn: "Ali", phone: null }).success;
      expect({ length, till }).toEqual({ length, till: wire });
    }
  });
});
