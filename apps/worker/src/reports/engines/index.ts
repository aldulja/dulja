import { AppError } from "@dulja/contracts";
import type { ReportOrientation, ReportPaper } from "@dulja/domain";
import { chromiumReportEngine } from "./chromium";

/**
 * ADR 0016 fixes the PDF engine — `chromium`, the one candidate that passed every measured criterion — and
 * hazard 30 forbids re-opening it. Its value set is `{chromium}`: Typst is recorded as a near-miss that a
 * later contracts amendment, migration and adapter could admit, and `react-pdf` renders a React component,
 * not text (ADR 0032). So this seam holds exactly one adapter, and both other codes are refused by name with
 * `ERR_PRINT_ENGINE_UNSUPPORTED`, exactly as `apps/api`'s `engineFor` refuses them.
 *
 * The adapter duplicates 2C's `apps/api/src/print/engines/chromium.ts` invocation deliberately: §3.1 forbids
 * `apps/worker` importing `apps/api`, and `engineFor` throws `AppError` so it cannot move into `packages/db`.
 * ADR 0066 records the duplication as forced. Both files are driven by ADR 0016 and read the same
 * `CHROMIUM_EXECUTABLE_PATH`.
 */
export type ReportPdfEngineCode = "chromium";

export interface ReportPdfEngine {
  readonly code: ReportPdfEngineCode;
  /** Cheap probe: is the browser present in this image? */
  available(): Promise<boolean>;
  render(
    source: string,
    opts: { paper: ReportPaper; orientation: ReportOrientation; dir: "ltr" | "rtl" },
  ): Promise<Uint8Array>;
}

export const REPORT_PDF_ENGINES: Readonly<Record<ReportPdfEngineCode, ReportPdfEngine>> = {
  chromium: chromiumReportEngine,
};

/** The resolution order — one member while ADR 0016's set has one. */
export const REPORT_PDF_ENGINE_ORDER: readonly ReportPdfEngineCode[] = ["chromium"];

export const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

let resolved: ReportPdfEngine | null = null;

/** Clears the memoised resolution (tests). */
export function resetReportPdfEngine(): void {
  resolved = null;
}

function refusal(code: string): string {
  if (code === "react-pdf")
    return "react-pdf renders a React component, not template text; a server-rendered report cannot use it (ADR 0032)";
  if (code === "typst")
    return "'typst' is ADR 0016's recorded near-miss, not a value in its engine set; admitting it needs a contracts amendment and an adapter first";
  return `'${code}' is not an ADR-0016 engine code; the set is ${REPORT_PDF_ENGINE_ORDER.join(", ")}`;
}

/**
 * The engine a report renders with. A named `code` is the `REPORT_PDF_ENGINE` developer override (ADR 0066 —
 * deliberately not a §3.11 row); without one, the first available engine in `REPORT_PDF_ENGINE_ORDER`,
 * resolved once per process. An image with no engine fails loudly rather than producing no PDF quietly.
 */
export async function reportPdfEngine(code?: string): Promise<ReportPdfEngine> {
  if (code !== undefined && code !== "") {
    if (Object.hasOwn(REPORT_PDF_ENGINES, code))
      return REPORT_PDF_ENGINES[code as ReportPdfEngineCode];
    throw new AppError("ERR_PRINT_ENGINE_UNSUPPORTED", refusal(code));
  }
  if (resolved !== null) return resolved;
  for (const candidate of REPORT_PDF_ENGINE_ORDER) {
    const engine = REPORT_PDF_ENGINES[candidate];
    if (await engine.available()) {
      resolved = engine;
      return engine;
    }
  }
  throw new AppError(
    "ERR_PRINT_ENGINE_UNSUPPORTED",
    "no ADR-0016 PDF engine is available in this image; install Playwright's chromium or name a host browser in CHROMIUM_EXECUTABLE_PATH",
  );
}

export { closeReportChromium, REPORT_RENDER_TIMEOUT_MS } from "./chromium";
