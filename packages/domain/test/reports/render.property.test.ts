import Decimal from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  intlFormatters,
  renderReport,
  type RenderedRow,
  type ReportDefinition,
} from "../../src/reports";

function grouped(nested: boolean): ReportDefinition {
  return {
    version: 1,
    code: "accounting.general_ledger",
    nameEn: "GL",
    nameAr: "دفتر",
    module: "accounting",
    permission: "accounting.report.read",
    parameters: [],
    dataset: { source: "ledger_entry", filters: [] },
    columns: [
      { field: "g", labelEn: "G", labelAr: "غ", format: "text", align: "start" },
      { field: "h", labelEn: "H", labelAr: "ح", format: "text", align: "start" },
      { field: "v", labelEn: "V", labelAr: "ق", format: "money", align: "end" },
    ],
    groups: nested
      ? [
          { field: "g", subtotal: true },
          { field: "h", subtotal: true },
        ]
      : [{ field: "g", subtotal: true }],
    totals: [{ field: "v", fn: "sum" }],
    sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "", footer: "" },
    tieOut: { kind: "none" },
  };
}

const rowSets = fc.array(
  fc.record({
    g: fc.constantFrom("a", "b", "c"),
    h: fc.constantFrom("x", "y"),
    v: fc
      .integer({ min: -9_999_999, max: 9_999_999 })
      .map((n) => new Decimal(n).div(10_000).toFixed(4)),
  }),
  { minLength: 1, maxLength: 40 },
);

const valueOf = (row: RenderedRow): Decimal =>
  new Decimal(String(row.cells.find((c) => c.field === "v")!.raw));

describe("renderReport totals arithmetic", () => {
  it("Σ subtotals = the grand total = Σ rows, exactly, over 2000 random row sets", () => {
    fc.assert(
      fc.property(rowSets, (rows) => {
        const r = renderReport(grouped(false), rows, {
          format: "csv",
          lang: "en",
          formatters: intlFormatters("en"),
        });
        const raw = (kind: "subtotal" | "total") =>
          r.rows
            .filter((row) => row.kind === kind)
            .map((row) => new Decimal(String(row.cells.find((c) => c.field === "v")!.raw)));
        const sumOfSubtotals = raw("subtotal").reduce((a, b) => a.plus(b), new Decimal(0));
        const sumOfRows = rows.reduce((a, row) => a.plus(row.v), new Decimal(0));
        expect(sumOfSubtotals.toFixed(4)).toBe(raw("total")[0]!.toFixed(4));
        expect(sumOfRows.toFixed(4)).toBe(raw("total")[0]!.toFixed(4));
      }),
      { numRuns: 2000 },
    );
  });

  it("with nested subtotals, each level's subtotals sum to the grand total", () => {
    fc.assert(
      fc.property(rowSets, (rows) => {
        const r = renderReport(grouped(true), rows, {
          format: "csv",
          lang: "en",
          formatters: intlFormatters("en"),
        });
        const level = (n: number) =>
          r.rows
            .filter((row) => row.kind === "subtotal" && row.level === n)
            .reduce((a, row) => a.plus(valueOf(row)), new Decimal(0));
        const total = valueOf(r.rows.find((row) => row.kind === "total")!);
        expect(level(1).toFixed(4)).toBe(total.toFixed(4));
        expect(level(2).toFixed(4)).toBe(total.toFixed(4));
        // one outer subtotal per distinct outer value — never one per inner bucket
        expect(r.rows.filter((row) => row.level === 1).length).toBe(
          new Set(rows.map((row) => row.g)).size,
        );
      }),
      { numRuns: 500 },
    );
  });
});
