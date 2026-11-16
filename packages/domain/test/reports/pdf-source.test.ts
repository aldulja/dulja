import { describe, expect, it } from "vitest";
import {
  intlFormatters,
  renderReport,
  reportToHtmlSource,
  type ReportDefinition,
} from "../../src/reports";

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
      { field: "c", labelEn: "Code <b>", labelAr: "الرمز", format: "text", align: "start" },
      { field: "v", labelEn: "Debit", labelAr: "مدين", format: "money", align: "end", width: 90 },
    ],
    groups: [],
    totals: [{ field: "v", fn: "sum" }],
    sort: [],
    layout: { orientation: "portrait", paper: "A4", header: "{title}", footer: "p" },
    tieOut: { kind: "none" },
  };
}
const ROWS = [{ c: "1000 & Co", v: "1.5000", currency: "MYR" }];
const AT = "2026-03-31T08:00:00Z";
const render = (lang: "en" | "ar", d: ReportDefinition = def()) =>
  renderReport(d, ROWS, { format: "pdf", lang, formatters: intlFormatters(lang), generatedAt: AT });

describe("reportToHtmlSource", () => {
  it("escapes every label and cell through 2C's htmlEscape — a report cannot inject markup", () => {
    const html = reportToHtmlSource(render("en"));
    expect(html).toContain("Code &lt;b&gt;");
    expect(html).toContain("1000 &amp; Co");
    expect(html).not.toContain("<b>");
  });

  it("sets dir and lang on <html> and uses logical CSS properties only (spec:2253, 0E's rule)", () => {
    expect(reportToHtmlSource(render("en"))).toContain('<html lang="en" dir="ltr">');
    const html = reportToHtmlSource(render("ar"));
    expect(html).toContain('<html lang="ar" dir="rtl">');
    for (const physical of [
      "margin-left",
      "margin-right",
      "padding-left",
      "padding-right",
      "border-left",
      "border-right",
      "text-align: left",
      "text-align: right",
    ]) {
      expect(html, physical).not.toContain(physical);
    }
    expect(html).toContain("text-align: end");
    expect(html).toContain("text-align: start");
  });

  it("keeps the columns in LOGICAL order in both languages — dir alone carries direction", () => {
    const en = reportToHtmlSource(render("en"));
    const ar = reportToHtmlSource(render("ar"));
    expect(en.indexOf("Code &lt;b&gt;")).toBeLessThan(en.indexOf(">Debit<"));
    expect(ar.indexOf("الرمز")).toBeLessThan(ar.indexOf("مدين"));
  });

  it("carries the Arabic title and every Arabic label", () => {
    const html = reportToHtmlSource(render("ar"));
    expect(html).toContain("<h1>ميزان المراجعة</h1>");
    expect(html).toContain("الإجمالي");
  });

  it("references no external URL, so the render fetches nothing and stays deterministic", () => {
    const html = reportToHtmlSource(render("ar"));
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("url(");
  });

  it("marks the data and total rows with a class a reviewer can see in the diff", () => {
    const html = reportToHtmlSource(render("en"));
    expect(html).toContain('class="row data"');
    expect(html).toContain('class="row total"');
  });

  it("sizes the page from §4.5.9's paper token and the orientation; a receipt has no landscape", () => {
    expect(reportToHtmlSource(render("en"))).toContain("size: A4 portrait;");
    const landscape = def();
    landscape.layout = { ...landscape.layout, paper: "A5", orientation: "landscape" };
    expect(reportToHtmlSource(render("en", landscape))).toContain("size: A5 landscape;");
    const receipt = def();
    receipt.layout = { ...receipt.layout, paper: "receipt", orientation: "landscape" };
    expect(reportToHtmlSource(render("en", receipt))).toContain("size: 80mm 297mm;");
  });

  it("carries a declared column width, and none where the definition gives none", () => {
    const html = reportToHtmlSource(render("en"));
    expect(html).toContain('<th style="text-align: end; width: 90px">Debit</th>');
    expect(html).toContain('<th style="text-align: start">Code &lt;b&gt;</th>');
  });

  it("is byte-deterministic for one report value", () => {
    const r = render("ar");
    expect(reportToHtmlSource(r)).toBe(reportToHtmlSource(r));
  });
});
