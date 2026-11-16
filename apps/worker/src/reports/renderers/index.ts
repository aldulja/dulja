import { AppError } from "@dulja/contracts";
import { REPORT_FORMATS, type ReportFormat } from "@dulja/domain";
import { csvRenderer } from "./csv";
import { pdfRenderer } from "./pdf";
import type { ReportRenderer } from "./types";
import { xlsxRenderer } from "./xlsx";

export {
  REPORT_CONTENT_TYPE,
  REPORT_EXTENSION,
  type RenderedArtefact,
  type ReportRenderer,
} from "./types";

/** One renderer per §4.11.2 format: PDF per ADR 0016, ExcelJS, CSV. Each turns ONE `RenderedReport` into
 *  bytes, so no format decides layout, direction or totals for itself (ADR 0066). */
export const REPORT_RENDERERS: Readonly<Record<ReportFormat, ReportRenderer>> = {
  csv: csvRenderer,
  pdf: pdfRenderer,
  xlsx: xlsxRenderer,
};

export function rendererFor(format: string): ReportRenderer {
  if (Object.hasOwn(REPORT_RENDERERS, format)) return REPORT_RENDERERS[format as ReportFormat];
  throw new AppError(
    "ERR_VALIDATION_FAILED",
    `report format '${format}' is not one of ${REPORT_FORMATS.toSorted().join(", ")}`,
  );
}
