import { htmlEscape } from "../print/escape";
import type { RenderedReport, RenderedRow } from "./render";

/**
 * The text the ADR-0016 engine consumes: one HTML document built from ONE `RenderedReport`, so the English
 * and Arabic outputs of a report can never diverge in structure — which is what makes test 23 a property of
 * the renderer rather than of two hand-kept templates (spec:2253).
 *
 * ADR 0016's value set is `{chromium}` alone (Typst is its recorded near-miss, `react-pdf` fails shaping and
 * bidi), so HTML is the only source form a report needs; a Typst builder would be a second spelling of one
 * layout for an engine nothing renders with (ADR 0066).
 *
 * Escaping goes through 2C's `htmlEscape` (`packages/domain/src/print/escape.ts`); a second escaper in this
 * file would be two spellings of one thing (hazard 9).
 */

/** `@page size` per §4.5.9's paper vocabulary. `receipt` is an 80 mm roll, as 2C's print path sizes it. */
const PAPER_CSS: Readonly<Record<RenderedReport["paper"], string>> = {
  A4: "A4",
  A5: "A5",
  receipt: "80mm 297mm",
};

const alignOf = (align: "start" | "end"): string => (align === "end" ? "end" : "start");

function rowHtml(report: RenderedReport, row: RenderedRow): string {
  const cells = row.cells
    .map(
      (cell, i) =>
        `<td style="text-align: ${alignOf(report.columns[i]?.align ?? "start")}">${htmlEscape(cell.text)}</td>`,
    )
    .join("");
  return `<tr class="row ${row.kind}">${cells}</tr>`;
}

export function reportToHtmlSource(report: RenderedReport): string {
  const head = report.columns
    .map((c) => {
      const width = c.width === null ? "" : `; width: ${c.width}px`;
      return `<th style="text-align: ${alignOf(c.align)}${width}">${htmlEscape(c.label)}</th>`;
    })
    .join("");
  const body = report.rows.map((row) => rowHtml(report, row)).join("");
  // A receipt is a continuous roll with no landscape form, as in 2C's print path.
  const size =
    report.paper === "receipt"
      ? PAPER_CSS.receipt
      : `${PAPER_CSS[report.paper]} ${report.orientation}`;
  // Every property below is LOGICAL (`start`/`end`, `margin-block`, `padding-inline`, `border-block`), which
  // is 0E's rule applied to a bare stylesheet: a physical left/right would be correct in one direction only.
  // No external URL, no <link>, no <script> — the engine runs with scripts off and every request aborted, so
  // the document must need nothing it would have to fetch.
  return `<!doctype html>
<html lang="${htmlEscape(report.lang)}" dir="${report.dir}">
<head><meta charset="utf-8"><title>${htmlEscape(report.title)}</title>
<style>
  @page { size: ${size}; margin: 12mm; }
  body { font-family: system-ui, sans-serif; font-size: 10pt; margin: 0; }
  h1 { font-size: 14pt; margin-block: 0 4mm; }
  .meta { font-size: 8pt; margin-block-end: 4mm; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding-block: 1.2mm; padding-inline: 2mm; border-block-end: 0.2mm solid #999; }
  th { font-weight: 600; }
  tr.subtotal td, tr.total td { font-weight: 700; border-block-start: 0.3mm solid #333; }
</style></head>
<body>
<h1>${htmlEscape(report.title)}</h1>
<div class="meta">${htmlEscape(report.header)}</div>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="meta">${htmlEscape(report.footer)}</div>
</body></html>
`;
}
