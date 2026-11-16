# ADR 0066 — Server-side report render: one layout, three renderers, a worker-local engine adapter

- **Status:** Proposed — implemented ahead of approval, as ADRs 0054–0065 were. It consumes ADR 0016 (the PDF
  engine) and ADR 0032 (`react-pdf` has no text adapter) and re-opens neither (contracts hazard 30).
- **Date:** 2026-11-05 (the plan's text is dated 2026-09-05)
- **Slice:** 7A · Task 10
- **Supersedes / superseded by:** —
- **Amends:** nothing in the contracts document. §3.11's holder change for the four `R2_*` names
  (`api, worker`) was already folded in by the architect; this record states why.

## Context

spec:2293 asks for "server-side render (PDF/XLSX/CSV)"; spec:2206 for async job semantics with a status
resource; spec:2253 for RTL/LTR parity on "every screen and every generated PDF, including numerals, Hijri
and Gregorian dates, and column order". Contracts §4.11.2 places the layout in
`packages/domain/src/reports/render.ts` (`renderReport`, Task 8) and the engine adapters in `apps/worker`:
"PDF per ADR 0016, ExcelJS, CSV". §3.1 forbids `apps/worker` importing `apps/api`, where 2C's `engineFor`
and `chromiumEngine` live.

ADR 0016's Decision is that the engine is Chromium print-to-PDF and that the engine value set is
`{chromium}`. Typst is its recorded near-miss (viable with a different Arabic face, excluded because it would
cost a second adapter nothing needs), and `react-pdf` fails shaping and bidi. That ADR's Consequences say
"7A ships the `chromium` `renderReport` adapter".

## Decision

1. **One layout, three renderers.** `renderReport` produces a `RenderedReport` value; each renderer in
   `apps/worker/src/reports/renderers/` turns that one value into bytes (`REPORT_RENDERERS`, `rendererFor`).
   Direction, labels, grouping, subtotals and totals are decided once, so the English and Arabic outputs of a
   report cannot diverge in structure, and test 23 is a property of the renderer rather than of two
   hand-kept templates.
2. **Direction is carried by `dir`, never by reversing the column array.** Reversing *and* setting `dir`
   double-flips. `RenderedReport.columns` is in logical order in both languages; the HTML sets `dir` and
   `lang` on `<html>` and uses only logical CSS properties; ExcelJS sets `rightToLeft` on the sheet view.
   Excel's `left`/`right` alignment is physical even on a right-to-left sheet, so a column's logical
   `start`/`end` is mapped per direction (`start` is `right` in Arabic) — the edge the PDF's
   `text-align: start` lands on under `dir="rtl"` — and the cell carries `readingOrder: rtl`.
3. **One PDF source form, HTML, and one engine adapter, `chromium`.** ADR 0016's set has one member, so the
   worker's seam (`ReportPdfEngine`, `REPORT_PDF_ENGINES`, `reportPdfEngine`) holds one adapter and refuses
   `typst` (the near-miss) and `react-pdf` (ADR 0032) by name with `ERR_PRINT_ENGINE_UNSUPPORTED`, as
   `engineFor` does. **The plan's Typst adapter and its `reportToTypstSource` builder are not built**: they
   would be a second engine ADR 0016 declined to admit, and admitting it later is that ADR's bounded path — a
   contracts amendment, a migration widening `print_template.engine`, then an adapter. The seam keeps its
   `available()` probe and its resolution order so that path adds a row rather than a redesign.
4. **The worker duplicates 2C's Chromium invocation, deliberately.** §3.1 forbids importing `apps/api`, and
   `engineFor` throws `AppError` from `@dulja/contracts`, which `packages/db` may not import — so there is no
   shared home. Both adapters read the same `CHROMIUM_EXECUTABLE_PATH` (§3.11; `containerSecrets` passes it
   to both classes), launch one browser per process that clears itself on a failed launch or a crash, add
   `--no-sandbox` only as root, render each document in a fresh context with JavaScript off and every request
   aborted, and bound each step. The report bound is 60 s against print's 15 s: a report is many pages, and
   §4.9's report SLO is the job's, not the page's. `REPORT_PDF_ENGINE` is a developer override, deliberately
   not a §3.11 row.
5. **Formatting is `@dulja/i18n`'s.** `i18nFormatters(lang)` adapts `formatDate` (`medium`), `formatNumber`,
   `formatMoney` and `formatQuantity`, with the calendar `intlFormatters` already defaults to — Hijri
   (`islamic-umalqura`) for `ar`, Gregorian for `en` — and Latin digits for both, 0E's `FormatContext`
   default. `@dulja/i18n` has no percent formatter, so a percent column's ratio is shifted two places as a
   string and formatted as a number with a `%` suffix; no float touches it. `apps/worker` gains
   `@dulja/i18n` in `dependency-rule`'s tier row.
6. **A spreadsheet cell holds the decimal STRING, with `numFmt` for display.** spec:2041: "No `number` type
   ever holds a monetary value", and 0D's `no-number-money` lint covers `apps/**`. The cost is that Excel
   shows "number stored as text" and an in-sheet `SUM()` needs `VALUE()`. That is accepted: a float in a
   monetary cell is the SAH-008 defect, the CSV carries the same raw strings, and 7C's tenant export is the
   machine-readable path. A subtotal or total row is bold; the header row is frozen; a literal `&` in the
   page header or footer is doubled, because Excel reads `&` as a field code.
7. **The CSV carries a BOM.** Its reader is an accountant opening it in Excel, which needs the BOM to sniff
   UTF-8 Arabic; `renderCsv`'s BOM stays opt-in for every other caller.
8. **Determinism is asserted at the rendered-TEXT layer, never at the byte layer.** Chromium embeds a
   `CreationDate` (ADR 0016's `pass*`), and an XLSX is a zip whose entries carry their own timestamps. The
   HTML source *is* byte-deterministic and is asserted as such; `pdfText` (§4.17.1) is the one test-side PDF
   reader.
9. **The rendered bytes go to the `ObjectStore` port** (§4.5.8, ADR 0031). `objectStoreFromEnv(env,
   appEnv)` applies §3.11's terms exactly as `apps/api`'s `readConfig` + `objectStoreFromConfig` do: all four
   `R2_*` names → `R2ObjectStore`; none of them in `dev` → `MemoryObjectStore`; some of them, or none outside
   `dev`, → an error naming every missing variable. The rule is reproduced rather than shared, for the same
   §3.1 reason as decision 4. `objectStore()` / `setObjectStore()` are the worker's twin of `log()` /
   `setLogger()`; Task 11's `reporting.render` handler reads it, and Task 11 wires it at boot.

## Consequences

- Test 23 is re-run for reports in `apps/worker/test/reports/pdf.test.ts`: labels, the Hijri and Gregorian
  dates and the figures `@dulja/i18n` produces, read back from real PDF bytes in both directions, plus the
  column order through `pdfText`'s reading order (an RTL page that ignored `dir` reads its heading reversed).
  `pdfText` reconstructs bidi per cluster, so two left-to-right cells side by side on an Arabic line come back
  merged in visual order; the test's Arabic fixture shows the Arabic account name, as a bilingual report
  would, and compares the Arabic money cell as figure and currency code.
- The worker image needs a Chromium and an Arabic-capable font, exactly as the API's does — one image, two
  entrypoints. `infra/Dockerfile` carries neither today (the known limit AGENTS.md records); without one,
  `reportPdfEngine()` fails loudly with `ERR_PRINT_ENGINE_UNSUPPORTED` naming both remedies.
- `apps/worker` gains `exceljs`, `playwright` (the range `apps/api` already pins, so one `playwright-core`
  is installed) and `@dulja/i18n`; versions are the lockfile's.
