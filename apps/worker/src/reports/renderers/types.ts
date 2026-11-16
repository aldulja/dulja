import type { RenderedReport, ReportFormat } from "@dulja/domain";

/** The bytes one renderer produced, with what the object store and the download need to serve them. */
export interface RenderedArtefact {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
}

export interface ReportRenderer {
  readonly format: ReportFormat;
  render(report: RenderedReport): Promise<RenderedArtefact>;
}

export const REPORT_CONTENT_TYPE: Readonly<Record<ReportFormat, string>> = {
  csv: "text/csv; charset=utf-8",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const REPORT_EXTENSION: Readonly<Record<ReportFormat, string>> = {
  csv: "csv",
  pdf: "pdf",
  xlsx: "xlsx",
};
