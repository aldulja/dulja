import { renderCsv } from "@dulja/domain";
import { REPORT_CONTENT_TYPE, REPORT_EXTENSION, type ReportRenderer } from "./types";

export const csvRenderer: ReportRenderer = {
  format: "csv",
  render(report) {
    // The BOM is on, because the reader is an accountant opening the file in Excel and Excel needs it to
    // sniff UTF-8 Arabic (ADR 0066). 7C's tenant export is the machine-readable path and does not use this.
    const bytes = new TextEncoder().encode(renderCsv(report, { bom: true }));
    return Promise.resolve({
      bytes,
      contentType: REPORT_CONTENT_TYPE.csv,
      extension: REPORT_EXTENSION.csv,
    });
  },
};
