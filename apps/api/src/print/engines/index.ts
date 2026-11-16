import { AppError } from "@dulja/contracts";
import { chromiumEngine } from "./chromium";

/**
 * ADR 0016's Decision — the closed value set of `print_template.engine`, the same set migration 0026's
 * CHECK holds. It is `chromium` alone: the ADR records Typst as a near-miss and `react-pdf` as failing
 * shaping and bidi, and hazard 30 forbids re-opening it here.
 */
export type PrintEngineCode = "chromium";

export interface PdfEngine {
  readonly code: PrintEngineCode;
  /** `paper` is `print_template.paper`; the adapter maps it to its own page-size vocabulary. */
  render(source: string, opts: { paper: string; dir: "ltr" | "rtl" }): Promise<Uint8Array>;
}

/** One adapter per ADR-0016 code that consumes template TEXT — today, exactly one. */
export const PDF_ENGINES: Readonly<Record<PrintEngineCode, PdfEngine>> = {
  chromium: chromiumEngine,
};

export const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

/**
 * `print_template.engine` is a text column read on every print, so the API fails closed rather than
 * trusting the CHECK: a row that names a code with no adapter here (ADR 0016's Alternatives path admits
 * `typst` by a later migration that could land before its adapter; `react-pdf` renders a React component
 * and can never consume template text) is a 422, never a 500 (ADR 0032).
 */
export function engineFor(code: string): PdfEngine {
  if (Object.hasOwn(PDF_ENGINES, code)) return PDF_ENGINES[code as PrintEngineCode];
  const detail =
    code === "react-pdf"
      ? "react-pdf renders a React component, not template text; a text-defined print template cannot use it (ADR 0032)"
      : `'${code}' has no print adapter; ADR 0016 admits ${Object.keys(PDF_ENGINES).join(", ")}`;
  throw new AppError("ERR_PRINT_ENGINE_UNSUPPORTED", detail);
}

export { closeChromium, configureChromium, RENDER_TIMEOUT_MS } from "./chromium";
