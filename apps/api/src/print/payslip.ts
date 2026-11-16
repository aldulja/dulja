import {
  renderReport,
  reportToHtmlSource,
  type ReportDefinition,
  type ReportFormatters,
  type ReportLang,
} from "@dulja/domain";
import type { PayslipBundle } from "@dulja/db";
import { engineFor, type PrintEngineCode } from "./engines";

// 8D T5 (amendments A4 and A11, contracts round 19; ADR 0079). A payslip is 7A's PURE layout (`renderReport` →
// `reportToHtmlSource`, `@dulja/domain`) through 2C's engine (`engineFor`, this app) — no worker, no job, no second
// engine registry (hazard 30: the PDF engine is decided once, in ADR 0016, and 2C, 7A and 8D consume it).

/**
 * The ADR-0016 engine a payslip renders through (8D A11). 2C's print route reads its engine off
 * `print_template.engine`; a payslip has no template row — it is a `ReportDefinition` — and hazard 30 forbids reading
 * the engine from the environment, because it is an ADR decision and not configuration. So it is a named constant in
 * one place. `"chromium"` is the one member of `PrintEngineCode` in the tree (ADR 0016's Decision); if a later
 * decision admits another, this one line changes.
 */
export const PAYSLIP_ENGINE: PrintEngineCode = "chromium";

/** No `sha256`: 2C's attachment service computes and stores the hash, and a second "hash of these bytes" here would be
 *  hazard 9. The caller reads it off the returned `AttachmentRow`. */
export interface RenderedPayslip {
  employeeId: string;
  fileName: string;
  bytes: Uint8Array;
}

/**
 * One payslip PDF. `generatedAt` is a parameter, not a clock read, and the shipped `hr.payslip` header and footer do
 * not print it, so two generations of the same posted run produce the same rendered TEXT — the layer test 33 compares
 * at (§4.5.9); the bytes differ by Chromium's creation date and are never compared.
 *
 * The header and footer placeholders are the bundle's header fields. The money figures are formatted by the run's
 * own formatters (the language's labels, the company's currency), the dates are printed as stored, and the employee's
 * name is the Arabic one on an Arabic payslip when the directory carries it.
 */
export async function renderPayslip(
  definition: ReportDefinition,
  bundle: PayslipBundle,
  opts: {
    lang: ReportLang;
    engine: PrintEngineCode;
    formatters: ReportFormatters;
    currency: string;
    generatedAt: string;
  },
): Promise<RenderedPayslip> {
  const h = bundle.header;
  const money = (amount: string): string =>
    opts.formatters.money({ amount, currency: opts.currency });
  const rendered = renderReport(definition, bundle.rows, {
    format: "pdf",
    lang: opts.lang,
    formatters: opts.formatters,
    generatedAt: opts.generatedAt,
    // `interpolate` renders an unknown `{name}` as the empty string, so a placeholder missing here is a blank in a
    // heading, never a failed render (7A's rule).
    parameters: {
      employeeNumber: h.employeeNumber,
      employeeName: opts.lang === "ar" ? (h.employeeNameAr ?? h.employeeNameEn) : h.employeeNameEn,
      employeeNameEn: h.employeeNameEn,
      branchCode: h.branchCode,
      periodStart: h.periodStart,
      periodEnd: h.periodEnd,
      payDate: h.payDate,
      runKind: h.runKind,
      documentNumber: h.documentNumber,
      gross: money(h.gross),
      totalDeductions: money(h.totalDeductions),
      net: money(h.net),
    },
  });
  // EXACTLY `{ paper, dir }` — 2C's `PdfEngine.render` signature. `hr.payslip` is a portrait A5, which is what the
  // adapter produces from `paper` alone; the landscape 8D definitions render through 7A's `reporting.render`.
  const bytes = await engineFor(opts.engine).render(reportToHtmlSource(rendered), {
    paper: rendered.paper,
    dir: rendered.dir,
  });
  return {
    employeeId: h.employeeId,
    fileName: `payslip-${h.employeeNumber}-${h.periodEnd}-${opts.lang}.pdf`,
    bytes,
  };
}
