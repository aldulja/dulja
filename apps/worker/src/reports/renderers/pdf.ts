import { reportToHtmlSource } from "@dulja/domain";
import { reportPdfEngine } from "../engines";
import { REPORT_CONTENT_TYPE, REPORT_EXTENSION, type ReportRenderer } from "./types";

export const pdfRenderer: ReportRenderer = {
  format: "pdf",
  async render(report) {
    // `REPORT_PDF_ENGINE` is a developer override, unset in every deployed environment (ADR 0066), and
    // deliberately not a §3.11 row: a container that needed it would mean the engine order is wrong.
    const engine = await reportPdfEngine(process.env["REPORT_PDF_ENGINE"]);
    const bytes = await engine.render(reportToHtmlSource(report), {
      paper: report.paper,
      orientation: report.orientation,
      dir: report.dir,
    });
    return { bytes, contentType: REPORT_CONTENT_TYPE.pdf, extension: REPORT_EXTENSION.pdf };
  },
};
