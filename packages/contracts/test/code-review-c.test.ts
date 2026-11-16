import { isCalendarDate } from "@dulja/domain";
import { describe, expect, it } from "vitest";
import { ReconciliationQuery } from "../src/accounting/bank";
import { ReverseDocumentBody } from "../src/accounting/document";
import { DateSchema } from "../src/common";

const issues = (value: string) => {
  const parsed = DateSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

const query = (asOf: string) =>
  ReconciliationQuery.safeParse({
    "filter[bank_account_id][eq]": "01900000-0000-7000-8000-000000000000",
    "filter[as_of][eq]": asOf,
  }).success;

/**
 * Code review, stream C — finding C5. `DateSchema` checked the shape only, so `2026-02-30` passed every
 * date-taking route and postgres.js rolled it over to 2026-03-02 on the way to a `date` column: a reversal
 * or a receipt could land in a different period than the one requested. The calendar check had been written
 * again in three places instead; it now lives once, in `@dulja/domain`, and `DateSchema` refines with it.
 */
describe("C5 — DateSchema is a calendar date, not a date-shaped string", () => {
  it.each([
    ["2026-02-30", "the thirtieth of February"],
    ["2025-02-29", "a leap day in a common year"],
    ["1900-02-29", "a leap day in a century that is not a leap year"],
    ["2026-13-01", "a thirteenth month"],
    ["2026-00-10", "a month zero"],
    ["2026-04-31", "the thirty-first of a thirty-day month"],
    ["2026-01-00", "a day zero"],
  ])("refuses %s (%s) with one calendar-date message", (value) => {
    expect(issues(value)).toEqual(["must be a calendar date YYYY-MM-DD"]);
  });

  it.each(["2024-02-29", "2000-02-29", "2026-02-28", "2026-12-31", "2026-01-01"])(
    "admits %s",
    (value) => {
      expect(DateSchema.safeParse(value).success).toBe(true);
    },
  );

  it("a malformed string carries the shape issue only — the calendar check does not pile a second on", () => {
    expect(issues("30/04/2026")).toHaveLength(1);
    expect(issues("30/04/2026")).not.toContain("must be a calendar date YYYY-MM-DD");
    expect(issues("2026-2-3")).toHaveLength(1);
  });

  it("the shared helper answers the same, and refuses what is not date-shaped at all", () => {
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("30/04/2026")).toBe(false);
    expect(isCalendarDate(" 2026-01-01")).toBe(false);
  });

  it("a route body built on DateSchema inherits the check — …/reverse's effectiveDate", () => {
    expect(
      ReverseDocumentBody.safeParse({ effectiveDate: "2026-02-30", reason: "x" }).success,
    ).toBe(false);
    expect(
      ReverseDocumentBody.safeParse({ effectiveDate: "2026-02-28", reason: "x" }).success,
    ).toBe(true);
  });

  it("the reconciliation query keeps refusing an impossible as_of now that it uses DateSchema itself", () => {
    expect(query("2026-02-30")).toBe(false);
    expect(query("2026-02-28")).toBe(true);
  });
});
