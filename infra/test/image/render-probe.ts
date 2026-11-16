/**
 * Runs INSIDE the runtime image (ci.yml's `image` job), as the image's own `bun` user:
 *
 *   docker run --rm --entrypoint bun -v "$PWD/infra/test/image:/probe:ro" -v "$OUT:/out" <image> /probe/render-probe.ts /out
 *
 * It prints one English and one Arabic report through each entrypoint's real PDF path — apps/worker's
 * `pdfRenderer` (engine resolution included: no `REPORT_PDF_ENGINE`, so the image's Chromium must be found on
 * its own) and apps/api's `chromiumEngine`, fed `reportToHtmlSource` exactly as `print/payslip.ts` feeds it —
 * and writes `<entrypoint>-<lang>.pdf` into the output directory. `check-pdfs.sh` then asserts on the bytes.
 * The image's modules are imported by absolute path: this file is mounted beside the image, not built into it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

type Lang = "en" | "ar";
interface Report {
  readonly paper: "A4";
  readonly orientation: "portrait";
  readonly dir: "ltr" | "rtl";
}
interface Modules {
  reportToHtmlSource(report: Report): string;
  pdfRenderer: { render(report: Report): Promise<{ bytes: Uint8Array }> };
  closeReportChromium(): Promise<void>;
  chromiumEngine: {
    render(source: string, opts: { paper: string; dir: "ltr" | "rtl" }): Promise<Uint8Array>;
  };
  closeChromium(): Promise<void>;
}

/** The labels check-pdfs.sh looks for in each PDF's text. Keep the two files in step. */
export const LABELS: Readonly<Record<Lang, readonly string[]>> = {
  en: ["Trial balance", "Account", "Balance", "Cash at bank"],
  ar: ["ميزان المراجعة", "الحساب", "الرصيد", "النقد في البنك"],
};

const column = (field: string, label: string, align: "start" | "end") => ({
  field,
  label,
  format: field === "balance" ? "money" : "text",
  align,
  width: null,
});

function report(lang: Lang): Report {
  const [title, account, balance, cash] = LABELS[lang];
  return {
    code: "accounting.trial_balance",
    title: title!,
    dir: lang === "ar" ? "rtl" : "ltr",
    lang,
    format: "pdf",
    header: title!,
    footer: "",
    paper: "A4",
    orientation: "portrait",
    columns: [column("account", account!, "start"), column("balance", balance!, "end")],
    rows: [
      {
        kind: "data",
        level: 0,
        label: null,
        cells: [
          { field: "account", text: cash!, raw: cash! },
          { field: "balance", text: "1,234.50", raw: "1234.5000" },
        ],
      },
    ],
    rowCount: 1,
    generatedAt: "2026-11-15T00:00:00.000Z",
  } as Report;
}

const out = process.argv[2] ?? "/out";
/** The image's WORKDIR; a local dry run against a checkout sets DULJA_APP_ROOT to the repository root. */
const app = process.env["DULJA_APP_ROOT"] ?? "/app";
const load = async (path: string): Promise<Record<string, unknown>> =>
  (await import(join(app, path))) as Record<string, unknown>;
const m = {
  ...(await load("packages/domain/src/index.ts")),
  ...(await load("apps/worker/src/reports/renderers/pdf.ts")),
  ...(await load("apps/worker/src/reports/engines/index.ts")),
  ...(await load("apps/api/src/print/engines/chromium.ts")),
} as unknown as Modules;

try {
  for (const lang of ["en", "ar"] as const) {
    const r = report(lang);
    writeFileSync(join(out, `worker-${lang}.pdf`), (await m.pdfRenderer.render(r)).bytes);
    writeFileSync(
      join(out, `api-${lang}.pdf`),
      await m.chromiumEngine.render(m.reportToHtmlSource(r), { paper: r.paper, dir: r.dir }),
    );
    process.stdout.write(`rendered ${lang} through apps/worker and apps/api\n`);
  }
} finally {
  await m.closeReportChromium();
  await m.closeChromium();
}
