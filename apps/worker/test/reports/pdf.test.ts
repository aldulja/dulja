import { AppError } from "@dulja/contracts";
import { renderReport, type ReportDefinition, type ReportLang } from "@dulja/domain";
import { afterAll, describe, expect, it } from "vitest";
import { pdfText } from "../../../../tests/support/pdf";
import {
  closeReportChromium,
  PDF_MAGIC,
  REPORT_PDF_ENGINE_ORDER,
  REPORT_PDF_ENGINES,
  reportPdfEngine,
  resetReportPdfEngine,
} from "../../src/reports/engines";
import { i18nFormatters } from "../../src/reports/formatters";
import { rendererFor } from "../../src/reports/renderers";

/** The name column is the reader's language, as a bilingual report shows it (both names are on the row). */
function def(lang: ReportLang = "en"): ReportDefinition {
  return {
    // `ledger_entry` rather than `account_balance`, because test 23's clause is "numerals, Hijri/Gregorian
    // dates and column order" and only the ledger dataset carries a date column (§4.16.2). A definition with
    // no `date` column could never exercise the calendar half of spec:2253 at all.
    version: 1,
    code: "accounting.ledger",
    nameEn: "Ledger",
    nameAr: "دفتر الأستاذ",
    module: "accounting",
    permission: "accounting.report.read",
    parameters: [],
    dataset: { source: "ledger_entry", filters: [] },
    columns: [
      { field: "account_code", labelEn: "Code", labelAr: "الرمز", format: "text", align: "start" },
      {
        field: lang === "ar" ? "account_name_ar" : "account_name_en",
        labelEn: "Name",
        labelAr: "الاسم",
        format: "text",
        align: "start",
      },
      {
        field: "effective_date",
        labelEn: "Date",
        labelAr: "التاريخ",
        format: "date",
        align: "start",
      },
      { field: "base_debit", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end" },
    ],
    groups: [],
    totals: [{ field: "base_debit", fn: "sum" }],
    sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "{rowCount}" },
    tieOut: { kind: "none" },
  };
}
const ON = "2026-01-15";
const ROWS = [
  {
    account_code: "1000",
    account_name_en: "Cash",
    account_name_ar: "النقد",
    effective_date: ON,
    base_debit: "120.5000",
    currency: "MYR",
  },
];

/**
 * A PDF engine may split one logical cell across several text items, and `Intl`'s Arabic output carries bidi
 * control characters (RLM, ALM, the isolate marks) that a PDF text layer may keep, drop or move. Neither is
 * what test 23 asserts — the assertion is the DIGITS and the CALENDAR — so both sides of every comparison
 * below are stripped of whitespace and of those controls before they meet. Spelled as \u escapes, never as
 * the literal characters: an invisible control in a source file is a defect of its own.
 */
const NOISE = /[\s\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
const packed = (text: string[]) => text.join("").replace(NOISE, "");
const strip = (value: string) => value.replace(NOISE, "");

const pdfOf = async (lang: ReportLang, d: ReportDefinition = def(lang)) => {
  const r = renderReport(d, ROWS, {
    format: "pdf",
    lang,
    formatters: i18nFormatters(lang, { currency: "MYR" }),
  });
  return rendererFor("pdf").render(r);
};

const refusalOf = async (code: string): Promise<AppError> => {
  try {
    await reportPdfEngine(code);
  } catch (e) {
    return e as AppError;
  }
  throw new Error(`reportPdfEngine(${code}) resolved`);
};

/** These cases launch a real headless Chromium (Playwright); the browser is closed after the file. */
describe("the PDF renderer — Part VI test 23 re-run (spec:2253)", () => {
  afterAll(async () => {
    resetReportPdfEngine();
    await closeReportChromium();
  });

  it("resolves ADR 0016's engine, and refuses react-pdf, typst and an unknown code by name", async () => {
    expect([...REPORT_PDF_ENGINE_ORDER]).toEqual(["chromium"]);
    expect(Object.keys(REPORT_PDF_ENGINES)).toEqual(["chromium"]);
    const engine = await reportPdfEngine();
    expect(engine.code).toBe("chromium");
    expect(await reportPdfEngine("chromium")).toBe(engine);

    const reactPdf = await refusalOf("react-pdf");
    expect(reactPdf).toBeInstanceOf(AppError);
    expect(reactPdf.code).toBe("ERR_PRINT_ENGINE_UNSUPPORTED");
    expect(reactPdf.detail).toMatch(/react-pdf renders a React component, not template text/);
    expect((await refusalOf("typst")).detail).toMatch(/near-miss, not a value in its engine set/);
    expect((await refusalOf("wkhtmltopdf")).detail).toMatch(/is not an ADR-0016 engine code/);
    expect((await refusalOf("toString")).code).toBe("ERR_PRINT_ENGINE_UNSUPPORTED");
  });

  it("renders a real PDF in English with every label and figure, columns in reading order", async () => {
    const { bytes, contentType, extension } = await pdfOf("en");
    expect(contentType).toBe("application/pdf");
    expect(extension).toBe("pdf");
    expect(bytes.slice(0, 5)).toEqual(PDF_MAGIC);
    const text = await pdfText(bytes);
    expect(text).toContain("Ledger");
    expect(text).toContain("Code Name Date Debit");
    expect(text.join(" ")).toContain("Cash");
    expect(text.join(" ")).toContain("Total");

    // spec:2253's CALENDAR half, English side: the Gregorian rendering `@dulja/i18n` produces, computed here
    // rather than written as a literal so the policy stays 0E's and this test never becomes a second one.
    const en = i18nFormatters("en", { currency: "MYR" });
    expect(packed(text)).toContain(strip(en.date(ON)));
    // …and its NUMERALS: the money cell and the total, as the formatter writes them.
    expect(packed(text)).toContain(strip(en.money({ amount: "120.5000", currency: "MYR" })));
  }, 120_000);

  it("renders the SAME report in Arabic: Arabic labels, and the columns laid out right to left", async () => {
    const text = await pdfText((await pdfOf("ar")).bytes);
    expect(text).toContain("دفتر الأستاذ");
    expect(text.join(" ")).toContain("النقد");
    expect(text.join(" ")).toContain("الإجمالي");
    // spec:2253's "column order". `pdfText` returns each line in READING order, so the Arabic heading row
    // reads code → name → date → debit exactly as the English one does — which is only true if the RTL page
    // really laid the columns out right to left and the reader undid it. A page that ignored `dir` would
    // read them reversed. Determinism is asserted at the rendered-TEXT layer, never at the byte layer —
    // Chromium embeds a CreationDate, so no test compares PDF bytes (§4.5.9, ADR 0016).
    expect(text).toContain("الرمز الاسم التاريخ مدين");
    expect(text).not.toContain("مدين التاريخ الاسم الرمز");
  }, 120_000);

  it("carries the Arabic NUMERALS and the Hijri date into the rendered PDF, and the two languages differ", async () => {
    // The other two thirds of test 23's clause, asserted on the BYTES' rendered text rather than on the
    // formatter in isolation: a renderer that dropped `formatters` and stringified the raw row would still
    // pass the label and column-order cases above, and would ship a report with a Gregorian date to an
    // Arabic reader. Both expected strings come from `@dulja/i18n` (`i18nFormatters`), so the numeral system
    // and the calendar stay 0E's and are not re-decided here.
    const ar = i18nFormatters("ar", { currency: "MYR" });
    const en = i18nFormatters("en", { currency: "MYR" });
    const arText = packed(await pdfText((await pdfOf("ar")).bytes));
    const enText = packed(await pdfText((await pdfOf("en")).bytes));

    expect(arText).toContain(strip(ar.date(ON))); // Hijri
    expect(enText).toContain(strip(en.date(ON))); // Gregorian
    expect(strip(ar.date(ON))).not.toBe(strip(en.date(ON))); // the two calendars really differ
    expect(arText).not.toContain(strip(en.date(ON)));

    // The NUMERALS: the figure exactly as each language's formatter writes it. In Arabic the money cell is
    // `<figure> MYR` — two left-to-right runs inside a right-to-left line, which the page lays out mirrored
    // and `pdfText`, seeing no Arabic letter in that cell to tell it the line's direction there, hands back
    // in visual order. So the Arabic side compares the figure and the currency code, each as formatted.
    const arMoney = strip(ar.money({ amount: "120.5000", currency: "MYR" }));
    const arFigure = arMoney.replace("MYR", "");
    expect(arFigure).toMatch(/^\d+\D\d{2}$/);
    expect(arText).toContain(arFigure);
    expect(arText).toContain(`MYR${arFigure}`);
    expect(enText).toContain(strip(en.money({ amount: "120.5000", currency: "MYR" })));
  }, 120_000);

  it("renders every §4.5.9 paper token and both orientations", async () => {
    for (const paper of ["A4", "A5", "receipt"] as const) {
      for (const orientation of ["portrait", "landscape"] as const) {
        const d = def();
        d.layout = { ...d.layout, paper, orientation };
        const { bytes } = await pdfOf("en", d);
        expect(bytes.slice(0, 5), `${paper}/${orientation}`).toEqual(PDF_MAGIC);
      }
    }
  }, 120_000);
});
