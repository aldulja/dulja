import type { RenderedReport, ReportColumnFormat } from "@dulja/domain";
import ExcelJS from "exceljs";
import { REPORT_CONTENT_TYPE, REPORT_EXTENSION, type ReportRenderer } from "./types";

/** Display formats only. The cell VALUE is always the stored decimal string (spec:2041, ADR 0066). */
const NUM_FMT: Readonly<Record<ReportColumnFormat, string | undefined>> = {
  money: "#,##0.0000",
  quantity: "#,##0.000000",
  percent: "0.0000%",
  integer: "#,##0",
  text: undefined,
  date: undefined,
};

/** ECMA-376 §18.18.43 paper sizes: 9 = A4, 11 = A5. A receipt roll has no sheet size; it prints on A4. */
const PAPER_SIZE: Readonly<Record<RenderedReport["paper"], number>> = { A4: 9, A5: 11, receipt: 9 };

/** Excel's header/footer text is a code language in which `&` introduces a field; a literal one is `&&`. */
const headerFooterText = (text: string): string => text.replaceAll("&", "&&");

/**
 * A column's LOGICAL alignment (`start` / `end`) onto Excel's physical one. Excel's `left` / `right` are
 * physical even on a right-to-left sheet, so `start` is `right` in Arabic — the same edge the PDF's
 * `text-align: start` lands on under `dir="rtl"`, which keeps the two formats of one report alike.
 */
function horizontal(align: "start" | "end", dir: "ltr" | "rtl"): "left" | "right" {
  const atStart = align === "start";
  return atStart === (dir === "ltr") ? "left" : "right";
}

export const xlsxRenderer: ReportRenderer = {
  format: "xlsx",
  async render(report) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Dulja";
    // The report's own clock, never the render's: `report.generatedAt` is the figure a reader sees.
    wb.created = new Date(report.generatedAt);
    wb.modified = new Date(report.generatedAt);
    const rtl = report.dir === "rtl";
    // Excel caps a sheet name at 31 characters and refuses seven punctuation marks in it.
    const sheetName =
      report.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || report.code.slice(0, 31);
    const ws = wb.addWorksheet(sheetName, {
      // spec:2253 — direction is the sheet's `rightToLeft`, never a reversed column array.
      views: [{ state: "frozen", ySplit: 1, rightToLeft: rtl }],
      pageSetup: {
        paperSize: PAPER_SIZE[report.paper],
        orientation: report.orientation,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      },
      headerFooter: {
        oddHeader: headerFooterText(report.header),
        oddFooter: headerFooterText(report.footer),
      },
    });

    ws.columns = report.columns.map((c) => {
      const numFmt = NUM_FMT[c.format];
      return {
        header: c.label,
        key: c.field,
        width: c.width === null ? 18 : Math.max(8, Math.round(c.width / 7)),
        style: {
          ...(numFmt === undefined ? {} : { numFmt }),
          alignment: {
            horizontal: horizontal(c.align, report.dir),
            ...(rtl ? { readingOrder: "rtl" as const } : {}),
          },
        },
      };
    });
    ws.getRow(1).font = { bold: true };

    for (const row of report.rows) {
      // The RAW value, as a string for every numeric format: a JS number here would put money in a float,
      // which spec:2041 forbids and 0D's no-number-money lint catches in apps/**.
      const added = ws.addRow(
        Object.fromEntries(
          row.cells.map((cell, i) => [
            report.columns[i]!.field,
            cell.raw === null ? null : String(cell.raw),
          ]),
        ),
      );
      // A subtotal or total row is bold, so a reader can find it without any colour.
      if (row.kind !== "data") added.font = { bold: true };
    }

    const buffer = await wb.xlsx.writeBuffer();
    return {
      bytes: new Uint8Array(buffer as ArrayBuffer),
      contentType: REPORT_CONTENT_TYPE.xlsx,
      extension: REPORT_EXTENSION.xlsx,
    };
  },
};
