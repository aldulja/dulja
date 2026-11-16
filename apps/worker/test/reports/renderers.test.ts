import { AppError } from "@dulja/contracts";
import { intlFormatters, renderReport, type ReportDefinition } from "@dulja/domain";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { i18nFormatters, shiftTwo } from "../../src/reports/formatters";
import {
  REPORT_CONTENT_TYPE,
  REPORT_EXTENSION,
  REPORT_RENDERERS,
  rendererFor,
} from "../../src/reports/renderers";

function def(): ReportDefinition {
  return {
    version: 1,
    code: "accounting.trial_balance",
    nameEn: "Trial balance",
    nameAr: "ميزان المراجعة",
    module: "accounting",
    permission: "accounting.report.read",
    parameters: [],
    dataset: { source: "account_balance", filters: [] },
    columns: [
      {
        field: "account_code",
        labelEn: "Code",
        labelAr: "الرمز",
        format: "text",
        align: "start",
        width: 80,
      },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
    ],
    groups: [],
    totals: [{ field: "base_debit", fn: "sum" }],
    sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "{title} & co", footer: "{rowCount}" },
    tieOut: { kind: "none" },
  };
}
const ROWS = [
  { account_code: "1000", base_debit: "120.5000", currency: "MYR" },
  { account_code: "1200", base_debit: "400.0000", currency: "MYR" },
];
const AT = "2026-03-31T08:00:00Z";
const report = (lang: "en" | "ar", format: "csv" | "xlsx" = "xlsx") =>
  renderReport(def(), ROWS, {
    format,
    lang,
    formatters: i18nFormatters(lang, { currency: "MYR" }),
    generatedAt: AT,
  });

async function sheetOf(bytes: Uint8Array): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  return wb.worksheets[0]!;
}

describe("the renderer registry", () => {
  it("holds exactly the three §4.11.2 formats, with their content types and extensions", () => {
    expect(Object.keys(REPORT_RENDERERS).toSorted()).toEqual(["csv", "pdf", "xlsx"]);
    expect(Object.keys(REPORT_CONTENT_TYPE).toSorted()).toEqual(["csv", "pdf", "xlsx"]);
    expect(REPORT_EXTENSION).toEqual({ csv: "csv", pdf: "pdf", xlsx: "xlsx" });
    for (const format of ["csv", "pdf", "xlsx"] as const)
      expect(rendererFor(format).format).toBe(format);
  });

  it("refuses an unknown format with ERR_VALIDATION_FAILED, and never reads the prototype", () => {
    expect(() => rendererFor("docx")).toThrowError(/format 'docx' is not one of csv, pdf, xlsx/);
    let raised: unknown = null;
    try {
      rendererFor("toString");
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(AppError);
    expect((raised as AppError).code).toBe("ERR_VALIDATION_FAILED");
  });
});

describe("the CSV renderer", () => {
  it("emits UTF-8 with a BOM and text/csv, carrying the raw strings, deterministically", async () => {
    const a = await rendererFor("csv").render(report("ar", "csv"));
    expect(a.contentType).toBe("text/csv; charset=utf-8");
    expect(a.extension).toBe("csv");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(a.bytes);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("الرمز,مدين\r\n");
    expect(text).toContain("1000,120.5000\r\n");
    expect(text).toContain("الإجمالي,520.5000\r\n");
    const again = await rendererFor("csv").render(report("ar", "csv"));
    expect(again.bytes).toEqual(a.bytes);
  });

  it("prefixes a formula-leading text cell with ' and leaves a negative amount raw", async () => {
    const r = renderReport(def(), [{ account_code: "=1+1", base_debit: "-5.0000" }], {
      format: "csv",
      lang: "en",
      formatters: i18nFormatters("en", { currency: "MYR" }),
      generatedAt: AT,
    });
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      (await rendererFor("csv").render(r)).bytes,
    );
    expect(text).toContain("\r\n'=1+1,-5.0000\r\n");
  });
});

describe("the XLSX renderer", () => {
  it("writes the header row, sets rightToLeft for ar, and never puts money in a JS number", async () => {
    const artefact = await rendererFor("xlsx").render(report("ar"));
    expect(artefact.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(artefact.extension).toBe("xlsx");
    const ws = await sheetOf(artefact.bytes);
    expect(ws.name).toBe("ميزان المراجعة");
    expect(ws.views[0]?.rightToLeft).toBe(true);
    expect(ws.getRow(1).getCell(1).value).toBe("الرمز");
    expect(ws.getRow(1).getCell(2).value).toBe("مدين");
    const money = ws.getRow(2).getCell(2);
    // spec:2041: no `number` type ever holds a monetary value, and 0D's no-number-money lint covers apps/**.
    expect(typeof money.value).toBe("string");
    expect(money.value).toBe("120.5000");
    expect(money.numFmt).toBe("#,##0.0000");
  });

  it("maps logical alignment onto Excel's physical edges per direction, as the PDF does", async () => {
    const ar = await sheetOf((await rendererFor("xlsx").render(report("ar"))).bytes);
    const en = await sheetOf((await rendererFor("xlsx").render(report("en"))).bytes);
    // `start` is the reading edge: left in English, right in Arabic; `end` is the other one.
    expect(en.getRow(2).getCell(1).alignment?.horizontal).toBe("left");
    expect(en.getRow(2).getCell(2).alignment?.horizontal).toBe("right");
    expect(ar.getRow(2).getCell(1).alignment?.horizontal).toBe("right");
    expect(ar.getRow(2).getCell(2).alignment?.horizontal).toBe("left");
    expect(ar.getRow(2).getCell(1).alignment?.readingOrder).toBe("rtl");
  });

  it("uses no rightToLeft for en, freezes the header row, and carries the page setup", async () => {
    const ws = await sheetOf((await rendererFor("xlsx").render(report("en"))).bytes);
    expect(ws.views[0]?.rightToLeft).toBeFalsy();
    expect(ws.views[0]?.state).toBe("frozen");
    expect((ws.views[0] as { ySplit?: number }).ySplit).toBe(1);
    expect(ws.pageSetup.paperSize).toBe(9);
    expect(ws.pageSetup.orientation).toBe("portrait");
    // A literal `&` in the header is doubled, or Excel would read it as a field code.
    expect(ws.headerFooter.oddHeader).toBe("Trial balance && co");
    expect(ws.headerFooter.oddFooter).toBe("2");
  });

  it("bolds the total row so a reader can find it without colour, and leaves data rows plain", async () => {
    const ws = await sheetOf((await rendererFor("xlsx").render(report("en"))).bytes);
    expect(ws.getRow(4).getCell(1).value).toBe("Total");
    expect(ws.getRow(4).getCell(2).value).toBe("520.5000");
    expect(ws.getRow(4).getCell(2).font?.bold).toBe(true);
    expect(ws.getRow(2).getCell(2).font?.bold).toBeFalsy();
  });
});

describe("the XLSX renderer and formula injection", () => {
  // ExcelJS writes a JS string as a shared string, never as a formula: only a `{ formula }` value object
  // makes an `<f>` element, and this renderer builds none. A text cell that starts with `=` therefore needs
  // no `'` prefix in the workbook, and gets none — the CSV renderer is the one that must neutralise it.
  it("stores a text cell and a header label that start with = + - @ as strings, not formulas", async () => {
    const d = def();
    d.columns[0] = { ...d.columns[0]!, labelEn: "=HYPERLINK()" };
    const r = renderReport(
      d,
      [
        { account_code: "=1+1", base_debit: "-5.0000" },
        { account_code: "@SUM(A1)", base_debit: "1.0000" },
        { account_code: "+60123", base_debit: "1.0000" },
        { account_code: "-2+3", base_debit: "1.0000" },
      ],
      {
        format: "xlsx",
        lang: "en",
        formatters: i18nFormatters("en", { currency: "MYR" }),
        generatedAt: AT,
      },
    );
    const ws = await sheetOf((await rendererFor("xlsx").render(r)).bytes);
    const cells = [
      ws.getRow(1).getCell(1),
      ...[2, 3, 4, 5].flatMap((n) => [ws.getRow(n).getCell(1), ws.getRow(n).getCell(2)]),
    ];
    for (const cell of cells) {
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.formula).toBeUndefined();
    }
    expect(ws.getRow(1).getCell(1).value).toBe("=HYPERLINK()");
    expect(ws.getRow(2).getCell(1).value).toBe("=1+1");
    expect(ws.getRow(2).getCell(2).value).toBe("-5.0000");
  });
});

describe("i18nFormatters", () => {
  it("delegates to @dulja/i18n, so the numeral and calendar policy stays 0E's", () => {
    // Hijri for ar, Gregorian for en — the calendar `intlFormatters` defaults to, so a report keeps its
    // shape when it moves from the layout tests to the worker.
    expect(i18nFormatters("ar").date("2026-01-15")).not.toBe(
      i18nFormatters("en").date("2026-01-15"),
    );
    expect(i18nFormatters("en").date("2026-01-15")).toBe("Jan 15, 2026");
    expect(i18nFormatters("en").money({ amount: "1234.5000", currency: "MYR" })).toContain(
      "1,234.50",
    );
    expect(
      i18nFormatters("en", { currency: "MYR" }).money({ amount: "1", currency: "" }),
    ).toContain("MYR");
    expect(i18nFormatters("en").quantity("2.5")).toBe(intlFormatters("en").quantity("2.5"));
  });

  it("formats a percent column's ratio as per cent without a float", () => {
    expect(i18nFormatters("en").percent("0.125")).toBe("12.5%");
    expect(i18nFormatters("en").percent("-0.5")).toBe("-50%");
    expect(i18nFormatters("en").percent("1.23456789")).toBe("123.4568%");
    expect(shiftTwo("0.125")).toBe("12.5");
    expect(shiftTwo("3")).toBe("300");
    expect(shiftTwo("-0.004")).toBe("-0.4");
    expect(shiftTwo("0.10")).toBe("10");
  });
});
