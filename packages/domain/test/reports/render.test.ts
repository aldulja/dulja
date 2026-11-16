import { describe, expect, it } from "vitest";
import {
  interpolate,
  intlFormatters,
  renderCsv,
  renderReport,
  type ReportDefinition,
  type ReportSourceRow,
} from "../../src/reports";

const AT = "2026-03-31T08:00:00Z";
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(160);

function trialBalance(): ReportDefinition {
  return {
    version: 1,
    code: "accounting.trial_balance",
    nameEn: "Trial balance",
    nameAr: "ميزان المراجعة",
    module: "accounting",
    permission: "accounting.report.read",
    parameters: [{ name: "fiscalPeriodId", kind: "period", required: true }],
    dataset: {
      source: "account_balance",
      filters: [{ field: "fiscal_period_id", op: "eq", param: "fiscalPeriodId" }],
    },
    columns: [
      { field: "account_type", labelEn: "Type", labelAr: "النوع", format: "text", align: "start" },
      {
        field: "account_code",
        labelEn: "Code",
        labelAr: "الرمز",
        format: "text",
        align: "start",
        width: 80,
      },
      {
        field: "account_name_en",
        labelEn: "Name",
        labelAr: "الاسم",
        format: "text",
        align: "start",
      },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
      { field: "base_credit", labelEn: "Credit", labelAr: "دائن", format: "money", align: "end" },
    ],
    groups: [{ field: "account_type", subtotal: true }],
    totals: [
      { field: "base_debit", fn: "sum" },
      { field: "base_credit", fn: "sum" },
    ],
    sort: [{ field: "account_code", dir: "asc" }],
    layout: {
      orientation: "portrait",
      paper: "A4",
      header: "{title} — {generatedAt}",
      footer: "{rowCount} rows",
    },
    tieOut: { kind: "ledger_sum" },
  };
}

const ROWS: readonly ReportSourceRow[] = [
  {
    account_type: "asset",
    account_code: "1200",
    account_name_en: "Trade receivables",
    base_debit: "400.0000",
    base_credit: "0.0000",
  },
  {
    account_type: "asset",
    account_code: "1000",
    account_name_en: "Cash",
    base_debit: "120.5000",
    base_credit: "0.0000",
  },
  {
    account_type: "income",
    account_code: "4000",
    account_name_en: "Sales",
    base_debit: "0.0000",
    base_credit: "520.5000",
  },
];

const EN = {
  format: "csv" as const,
  lang: "en" as const,
  formatters: intlFormatters("en", { currency: "MYR" }),
  generatedAt: AT,
};

type Row = ReturnType<typeof renderReport>["rows"][number];
const cellOf = (row: Row, field: string) => row.cells.find((c) => c.field === field)!;

describe("renderReport — grouping, subtotals, totals, sort", () => {
  it("emits data rows in sort order inside each group, a subtotal per group and one grand total", () => {
    const r = renderReport(trialBalance(), ROWS, EN);
    expect(r.rows.map((row) => [row.kind, row.level, row.label, row.cells[1]?.raw])).toEqual([
      ["data", 0, null, "1000"],
      ["data", 0, null, "1200"],
      ["subtotal", 1, "asset", null],
      ["data", 0, null, "4000"],
      ["subtotal", 1, "income", null],
      ["total", 0, null, null],
    ]);
    expect(r.rowCount).toBe(3);
  });

  it("subtotals and the grand total are exact decimal sums, never floats", () => {
    const r = renderReport(trialBalance(), ROWS, EN);
    const assetSubtotal = r.rows.find((row) => row.kind === "subtotal" && row.label === "asset")!;
    expect(cellOf(assetSubtotal, "base_debit").raw).toBe("520.5000");
    const total = r.rows.find((row) => row.kind === "total")!;
    expect(cellOf(total, "base_debit").raw).toBe("520.5000");
    expect(cellOf(total, "base_credit").raw).toBe("520.5000");
    // A text column carries no aggregate on a subtotal or total row.
    expect(cellOf(total, "account_name_en").raw).toBeNull();
    // 0.1 + 0.2 is the float trap; Decimal makes it exact.
    const def = trialBalance();
    def.groups = [];
    const exact = renderReport(
      def,
      [
        { ...ROWS[0]!, base_debit: "0.1000" },
        { ...ROWS[1]!, base_debit: "0.2000" },
      ],
      EN,
    );
    expect(cellOf(exact.rows.at(-1)!, "base_debit").raw).toBe("0.3000");
  });

  it("count and avg do what their names say, avg rounding HALF_EVEN at the column's scale", () => {
    const def = trialBalance();
    def.totals = [
      { field: "base_debit", fn: "avg" },
      { field: "account_code", fn: "count" },
    ];
    const r = renderReport(def, ROWS, EN);
    const total = r.rows.find((row) => row.kind === "total")!;
    // 520.5000 / 3 = 173.50000 → HALF_EVEN at scale 4 → 173.5000
    expect(cellOf(total, "base_debit").raw).toBe("173.5000");
    expect(cellOf(total, "account_code").raw).toBe(3);

    // HALF_EVEN, not HALF_UP: 0.00025 / 1 at scale 4 goes to the even neighbour 0.0002. Two rows whose sum is
    // 0.0005 average to 0.00025 exactly.
    def.groups = [];
    const tie = renderReport(
      def,
      [
        { ...ROWS[0]!, base_debit: "0.0001" },
        { ...ROWS[1]!, base_debit: "0.0004" },
      ],
      EN,
    );
    expect(cellOf(tie.rows.at(-1)!, "base_debit").raw).toBe("0.0002");
  });

  it("counts a text column without reading its values as numbers", () => {
    const def = trialBalance();
    def.totals = [{ field: "account_name_en", fn: "count" }];
    const r = renderReport(def, ROWS, EN);
    expect(
      cellOf(
        r.rows.find((row) => row.kind === "total")!,
        "account_name_en",
      ).raw,
    ).toBe(ROWS.length);
  });

  it("groups nest, and only a group marked subtotal emits a row", () => {
    const def = trialBalance();
    def.columns = [
      ...def.columns,
      { field: "currency", labelEn: "Ccy", labelAr: "العملة", format: "text", align: "start" },
    ];
    def.groups = [
      { field: "account_type", subtotal: true },
      { field: "currency", subtotal: false },
    ];
    const rows = ROWS.map((r) => ({ ...r, currency: "MYR" }));
    const r = renderReport(def, rows, EN);
    expect(
      r.rows.filter((row) => row.kind === "subtotal").map((row) => [row.level, row.label]),
    ).toEqual([
      [1, "asset"],
      [1, "income"],
    ]);
  });

  it("an outer subtotal covers every inner bucket it contains, and the inner one comes first", () => {
    // The per-branch statement shape (Task 9): branch, then section, both subtotalled. The branch subtotal
    // must be ONE row per branch summing all its sections — never one per (branch, section) bucket.
    const def = trialBalance();
    def.columns = [
      { field: "branch_code", labelEn: "Branch", labelAr: "الفرع", format: "text", align: "start" },
      ...def.columns,
    ];
    def.groups = [
      { field: "branch_code", subtotal: true },
      { field: "account_type", subtotal: true },
    ];
    const rows = [
      ...ROWS.map((r) => ({ ...r, branch_code: "HQ" })),
      { ...ROWS[1]!, branch_code: "KL", base_debit: "10.0000" },
    ];
    const r = renderReport(def, rows, EN);
    expect(
      r.rows
        .filter((row) => row.kind !== "data")
        .map((row) => [row.kind, row.level, row.label, cellOf(row, "base_debit").raw]),
    ).toEqual([
      ["subtotal", 2, "asset", "520.5000"],
      ["subtotal", 2, "income", "0.0000"],
      ["subtotal", 1, "HQ", "520.5000"],
      ["subtotal", 2, "asset", "10.0000"],
      ["subtotal", 1, "KL", "10.0000"],
      ["total", 0, null, "530.5000"],
    ]);
  });

  it("sorts descending, numerically for numeric strings, with nulls first ascending", () => {
    const def = trialBalance();
    def.groups = [];
    def.totals = [];
    def.sort = [{ field: "account_code", dir: "desc" }];
    const rows: ReportSourceRow[] = [
      { ...ROWS[0]!, account_code: "900" },
      { ...ROWS[1]!, account_code: "1000" },
      { ...ROWS[2]!, account_code: null },
    ];
    expect(renderReport(def, rows, EN).rows.map((row) => row.cells[1]!.raw)).toEqual([
      "1000",
      "900",
      null,
    ]);
    def.sort = [{ field: "account_code", dir: "asc" }];
    expect(renderReport(def, rows, EN).rows.map((row) => row.cells[1]!.raw)).toEqual([
      null,
      "900",
      "1000",
    ]);
  });

  it("emits no total row for an empty dataset, and none for a definition with no totals", () => {
    expect(renderReport(trialBalance(), [], EN).rows).toEqual([]);
    const def = trialBalance();
    def.totals = [];
    expect(renderReport(def, ROWS, EN).rows.every((row) => row.kind === "data")).toBe(true);
  });
});

describe("renderReport — direction, labels and the header", () => {
  it("uses the Arabic labels and dir=rtl for lang ar, and keeps the column order logical", () => {
    const r = renderReport(trialBalance(), ROWS, {
      ...EN,
      lang: "ar",
      formatters: intlFormatters("ar", { currency: "MYR" }),
    });
    expect(r.dir).toBe("rtl");
    expect(r.title).toBe("ميزان المراجعة");
    expect(r.columns.map((c) => c.label)).toEqual(["النوع", "الرمز", "الاسم", "مدين", "دائن"]);
    // spec:2253's "column order" is carried by `dir`, not by reversing the array — reversing AND setting dir
    // double-flips, which is the bug the requirement exists to prevent.
    expect(r.columns.map((c) => c.field)).toEqual(
      renderReport(trialBalance(), ROWS, EN).columns.map((c) => c.field),
    );
    expect(r.rows.at(-1)!.cells[0]!.text).toBe("الإجمالي");
    expect(renderReport(trialBalance(), ROWS, EN).dir).toBe("ltr");
  });

  it("interpolates the header and footer from the parameters and the four built-ins", () => {
    const def = trialBalance();
    def.layout.header = "{title} / {code} / {fiscalPeriodId} / {missing}";
    const r = renderReport(def, ROWS, { ...EN, parameters: { fiscalPeriodId: "2026-03" } });
    expect(r.header).toBe("Trial balance / accounting.trial_balance / 2026-03 / ");
    expect(r.footer).toBe("3 rows");
    expect(r.generatedAt).toBe(AT);
    expect(r.paper).toBe("A4");
    expect(r.orientation).toBe("portrait");
  });

  it("interpolate leaves a doubled brace alone and never throws on an unknown name", () => {
    expect(interpolate("{{literal}} {a}", { a: "x" })).toBe("{literal} x");
    expect(interpolate("{nope}", {})).toBe("");
    // Only the map's own keys: an inherited Object member is an unknown name, not a function's source text.
    expect(interpolate("{constructor}{toString}", {})).toBe("");
  });

  it("formats money, quantity, percent, date and integer cells and keeps the raw string beside the text", () => {
    const def = trialBalance();
    def.columns = [
      { field: "d", labelEn: "D", labelAr: "د", format: "date", align: "start" },
      { field: "q", labelEn: "Q", labelAr: "ك", format: "quantity", align: "end" },
      { field: "p", labelEn: "P", labelAr: "ن", format: "percent", align: "end" },
      { field: "n", labelEn: "N", labelAr: "ع", format: "integer", align: "end" },
      { field: "m", labelEn: "M", labelAr: "م", format: "money", align: "end" },
    ];
    def.groups = [];
    def.totals = [];
    def.sort = [];
    const r = renderReport(
      def,
      [{ d: "2026-01-15", q: "3.000000", p: "0.060000", n: 7, m: "1234.5000" }],
      EN,
    );
    const cells = r.rows[0]!.cells;
    // `intlFormatters("en")` builds the tag `en-u-ca-gregory-nu-latn`, which ICU resolves to en-US ordering:
    // month-first, `Jan 15, 2026` — the same string 0E's `formatDate(iso, ctx, "medium")` gives for `en`.
    expect(cells[0]!.text).toBe("Jan 15, 2026");
    expect(cells[0]!.raw).toBe("2026-01-15");
    expect(cells[1]!.text).toBe("3.000000");
    expect(cells[2]!.text).toBe("6%");
    expect(cells[3]!.text).toBe("7");
    // `currencyDisplay: "code"` separates the code from the number with U+00A0 NO-BREAK SPACE; the separator
    // is normalised by code point for the comparison and pinned by code point after it, so no line in this
    // file carries an invisible character.
    expect(cells[4]!.text.split(NBSP).join(" ")).toBe("MYR 1,234.50");
    expect(cells[4]!.text.charCodeAt(3)).toBe(160);
    expect(cells[4]!.raw).toBe("1234.5000"); // the stored string, never re-computed (spec:2041)
  });

  it("a money cell takes its row set's currency before the formatter's default", () => {
    const def = trialBalance();
    def.columns = [{ field: "m", labelEn: "M", labelAr: "م", format: "money", align: "end" }];
    def.groups = [];
    def.totals = [];
    def.sort = [];
    const r = renderReport(def, [{ m: "1.0000", currency: "USD" }], EN);
    expect(r.rows[0]!.cells[0]!.text.startsWith("USD")).toBe(true);
  });

  it("formats a far-out-of-float-range amount exactly from its string", () => {
    const def = trialBalance();
    def.columns = [{ field: "q", labelEn: "Q", labelAr: "ك", format: "quantity", align: "end" }];
    def.groups = [];
    def.totals = [];
    def.sort = [];
    // 19 significant digits — beyond a float's 15–17. A `Number()` anywhere would change the last digits.
    const r = renderReport(def, [{ q: "1234567890123.123456" }], EN);
    expect(r.rows[0]!.cells[0]!.text).toBe("1234567890123.123456");
  });

  it("renders a null as the empty string in every format", () => {
    const def = trialBalance();
    def.columns = [{ field: "m", labelEn: "M", labelAr: "م", format: "money", align: "end" }];
    def.groups = [];
    def.totals = [];
    def.sort = [];
    const r = renderReport(def, [{ m: null }], EN);
    expect(r.rows[0]!.cells[0]!.text).toBe("");
    expect(r.rows[0]!.cells[0]!.raw).toBeNull();
  });
});

describe("intlFormatters", () => {
  it("defaults to the Hijri calendar for ar and the Gregorian for en, both in Latin digits", () => {
    const ar = intlFormatters("ar").date("2026-01-15");
    const en = intlFormatters("en").date("2026-01-15");
    expect(ar).not.toBe(en);
    expect(ar).toMatch(/[0-9]/);
    expect(ar).not.toMatch(/2026/); // 1447 AH, not the Gregorian year
    expect(intlFormatters("ar", { calendar: "gregory" }).date("2026-01-15")).toMatch(/2026/);
  });

  it("never shifts a date column's calendar day, whatever the display time zone", () => {
    const f = intlFormatters("en", { timeZone: "Pacific/Kiritimati" });
    expect(f.date("2026-01-15")).toBe("Jan 15, 2026");
    expect(intlFormatters("en", { timeZone: "Pacific/Pago_Pago" }).date("2026-01-15")).toBe(
      "Jan 15, 2026",
    );
  });
});

describe("renderCsv", () => {
  it("emits a header row, CRLF endings and RFC 4180 quoting, deterministically", () => {
    const def = trialBalance();
    def.groups = [];
    def.totals = [];
    def.sort = [];
    def.columns = [
      { field: "a", labelEn: 'Say "hi"', labelAr: "قل", format: "text", align: "start" },
      { field: "b", labelEn: "B,C", labelAr: "ب", format: "text", align: "start" },
    ];
    const r = renderReport(def, [{ a: 'he said "no"', b: "x\ny" }], EN);
    const csv = renderCsv(r);
    expect(csv).toBe('"Say ""hi""","B,C"\r\n"he said ""no""","x\ny"\r\n');
    expect(renderCsv(r)).toBe(csv);
  });

  it("labels a subtotal and a total row in the first column and writes RAW values, not formatted ones", () => {
    const r = renderReport(trialBalance(), ROWS, EN);
    const lines = renderCsv(r).split("\r\n");
    // The row inventory is asserted in FULL rather than sampled: one header line, then the six rows the first
    // `it` in this file pins — data 1000, data 1200, subtotal asset, data 4000, subtotal income, total — joined
    // with CRLF, so the grand total is index 6 and the trailing CRLF leaves an empty index 7.
    expect(lines).toEqual([
      "Type,Code,Name,Debit,Credit",
      "asset,1000,Cash,120.5000,0.0000",
      "asset,1200,Trade receivables,400.0000,0.0000",
      "Subtotal asset,,,520.5000,0.0000",
      "income,4000,Sales,0.0000,520.5000",
      "Subtotal income,,,0.0000,520.5000",
      "Total,,,520.5000,520.5000",
      "",
    ]);
  });

  it("prepends a UTF-8 BOM only when asked, so Excel reads Arabic and a parser is unaffected", () => {
    const r = renderReport(trialBalance(), ROWS, {
      ...EN,
      lang: "ar",
      formatters: intlFormatters("ar"),
    });
    expect(renderCsv(r).startsWith(BOM)).toBe(false);
    expect(renderCsv(r, { bom: true }).startsWith(BOM)).toBe(true);
    expect(renderCsv(r).split("\r\n")[0]).toBe("النوع,الرمز,الاسم,مدين,دائن");
  });

  // OWASP "CSV Injection": a spreadsheet evaluates a cell that begins with = + - @ TAB or CR as a formula, and
  // this file carries a BOM precisely so Excel opens it. A party name, a memo or a cloned definition's label is
  // user-entered text, so each such cell is prefixed with `'` (then quoted as usual); a numeric column's plain
  // decimal — a negative amount above all — is the figure itself and stays untouched.
  it("neutralises a text cell or label that a spreadsheet would read as a formula, and leaves amounts raw", () => {
    const def = trialBalance();
    def.groups = [];
    def.totals = [];
    def.sort = [];
    def.columns = [
      { field: "name", labelEn: "=HYPERLINK()", labelAr: "ن", format: "text", align: "start" },
      { field: "code", labelEn: "Code", labelAr: "ر", format: "text", align: "start" },
      { field: "amount", labelEn: "Amount", labelAr: "م", format: "money", align: "end" },
      { field: "qty", labelEn: "Qty", labelAr: "ك", format: "quantity", align: "end" },
    ];
    const rows: ReportSourceRow[] = [
      { name: "=1+1", code: "+60123", amount: "-5.0000", qty: "-2.500000" },
      { name: "@SUM(A1)", code: "-5", amount: "0.0000", qty: "1.000000" },
      { name: "\tTAB", code: "\rCR", amount: "=cmd|' /C calc'!A0", qty: "-1+1" },
      { name: "Plain", code: "a=b", amount: "12.5000", qty: null },
    ];
    const lines = renderCsv(renderReport(def, rows, EN)).split("\r\n");
    expect(lines).toEqual([
      "'=HYPERLINK(),Code,Amount,Qty",
      "'=1+1,'+60123,-5.0000,-2.500000",
      "'@SUM(A1),'-5,0.0000,1.000000",
      `'\tTAB,"'\rCR",'=cmd|' /C calc'!A0,'-1+1`,
      "Plain,a=b,12.5000,",
      "",
    ]);
  });
});
