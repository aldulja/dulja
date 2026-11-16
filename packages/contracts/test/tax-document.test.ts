import { describe, expect, it } from "vitest";
import { DocumentLineInput } from "../src/accounting/document";
describe("tax document wire contract", () => {
  it("DocumentLineInput accepts taxCodeId, and keeps every 1A constraint it already had", () => {
    const ok = DocumentLineInput.safeParse({
      lineNo: 1,
      kind: "account",
      accountId: "00000000-0000-7000-8000-000000000001",
      debit: "100.0000",
      taxCodeId: "00000000-0000-7000-8000-000000000002",
    });
    expect(ok.success).toBe(true);
    // Omitted is still valid — the field is optional and the column is nullable.
    expect(
      DocumentLineInput.safeParse({
        lineNo: 1,
        kind: "account",
        accountId: "00000000-0000-7000-8000-000000000001",
        debit: "100.0000",
      }).success,
    ).toBe(true);
    // A non-uuid is ERR_VALIDATION_FAILED before the handler runs, so no bad id reaches the FK.
    expect(
      DocumentLineInput.safeParse({
        lineNo: 1,
        kind: "account",
        accountId: "00000000-0000-7000-8000-000000000001",
        debit: "100.0000",
        taxCodeId: "SST",
      }).success,
    ).toBe(false);
    // 1A's debit-or-credit refine survives the addition.
    expect(
      DocumentLineInput.safeParse({
        lineNo: 1,
        kind: "account",
        accountId: "00000000-0000-7000-8000-000000000001",
        debit: "1.0000",
        credit: "1.0000",
      }).success,
    ).toBe(false);
  });
});
