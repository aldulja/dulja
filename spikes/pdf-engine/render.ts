// `typst` is a native binary, not an npm package — install it separately before running this
// script: `winget install --id Typst.Typst` on Windows, `brew install typst` on macOS.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = join(import.meta.dir, "out");
mkdirSync(OUT, { recursive: true });
const fixturePath = join(import.meta.dir, "fixture/invoice.json");
const fixture = readFileSync(fixturePath, "utf8");

// This host has no Noto Sans Arabic / Noto Sans installed as a system font, and the npm
// @fontsource packages (installed for candidate C, below) ship only .woff/.woff2 — a format
// Typst's font loader does not read. `fonts/` holds real .ttf builds of the same two families
// (fetched from the upstream google/fonts repository; see fonts/NOTICE.md) so that candidates A
// and B can be given the identical Arabic-capable font candidate C already uses, keeping the font
// constant across all three and letting the comparison measure the engines, not the host's
// preinstalled typefaces. This substitution is recorded in ADR 0016.
const notoSansArabicBase64 = readFileSync(join(import.meta.dir, "fonts/NotoSansArabic.ttf")).toString("base64");
const notoSansBase64 = readFileSync(join(import.meta.dir, "fonts/NotoSans.ttf")).toString("base64");
const fontFaceCss = `
  @font-face { font-family: "Noto Sans Arabic"; src: url(data:font/ttf;base64,${notoSansArabicBase64}) format("truetype"); }
  @font-face { font-family: "Noto Sans"; src: url(data:font/ttf;base64,${notoSansBase64}) format("truetype"); }
`;

for (const dir of ["ltr", "rtl"] as const) {
  // A — Typst. `json(sys.inputs.fixture)` in invoice.typ reads through Typst's sandboxed virtual
  // filesystem, not the OS filesystem directly, so the fixture path must be given relative to
  // invoice.typ's own directory ("../../fixture/invoice.json") rather than as an absolute OS path:
  // on Windows, Typst 0.15's sandbox rejects any path containing a drive-letter component such as
  // "C:" ("path contains invalid component `\"C:\"`"), whether that component comes from an
  // absolute --input value or from a root-relative ("/…") one combined with --root. --root "." with
  // cwd set to this directory keeps the whole spike (candidates/ and fixture/) inside one sandbox.
  // --font-path adds fonts/ (see above) so "Noto Sans Arabic"/"Noto Sans" actually resolve.
  // --creation-timestamp pins the document's embedded creation/XMP dates to a fixed instant:
  // without it, two otherwise-identical compiles differ only in that timestamp (confirmed via
  // byte-diff), which would fail a byte-identical determinism check for a reason that has nothing
  // to do with the engine's output. The value itself is arbitrary and fixed only for reproducibility.
  try {
    execFileSync("typst", [
      "compile", "--root", ".", "--font-path", "fonts", "--creation-timestamp", "1700000000",
      "candidates/typst/invoice.typ",
      `out/typst-${dir}.pdf`,
      "--input", "fixture=../../fixture/invoice.json", "--input", `dir=${dir}`,
    ], { stdio: "inherit", cwd: import.meta.dir });
  } catch (cause) {
    console.error(`typst ${dir} failed:`, cause);
  }

  // B — Chromium print-to-PDF (the same engine Electron's webContents.printToPDF uses). The
  // fixture JSON and the two @font-face rules above are inlined into the static candidate HTML;
  // candidates/chromium/invoice.html itself is untouched.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const html = readFileSync(join(import.meta.dir, "candidates/chromium/invoice.html"), "utf8")
    .replace('<html>', `<html lang="${dir === "rtl" ? "ar" : "en"}" dir="${dir}">`)
    .replace("</style>", `${fontFaceCss}</style>`)
    .replace('<script id="fixture" type="application/json"></script>',
             `<script id="fixture" type="application/json">${fixture}</script>`);
  await page.setContent(html, { waitUntil: "networkidle" });
  writeFileSync(join(OUT, `chromium-${dir}.pdf`), await page.pdf({ format: "A4", printBackground: true }));
  await browser.close();

  // C — @react-pdf/renderer. `renderInvoice(fixture, dir): Promise<Buffer>` is exported by
  // candidates/react-pdf/invoice.tsx above; the dynamic import keeps the font registration (a
  // module-level side effect) out of the process until this candidate actually runs.
  const { renderInvoice } = await import("./candidates/react-pdf/invoice");
  writeFileSync(join(OUT, `react-pdf-${dir}.pdf`), await renderInvoice(JSON.parse(fixture), dir));
}

console.log(`wrote six PDFs to ${OUT}`);
