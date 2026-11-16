# 0016 — PDF engine for documents and reports

**Status:** accepted · **Date:** 2026-09-16 · **Slice:** 0E
**Spec:** §3.2.2 PDF row (spec:1132) — "Decide in week one — Typst or a shaping-aware library. ⚠️ Largest
technical risk in reporting: Arabic RTL glyph shaping. Prove it with a real tax invoice before Phase 6";
§0.2 (spec:93) puts this in *agent verifies and records an ADR — do not stop*.
**Consumed by:** 2C (`app.print_template.engine`, contracts §4.5.9, migration 0026), 7A
(`renderReport` adapters, contracts §4.11.2), 8D (payslips and annual statements). **Never re-opened**
(contracts §5 hazard 30).

## Criteria

1. **Shaping** — contextual forms and the lam-alef ligature render correctly.
2. **Bidi** — a mixed Arabic/Latin/digit run orders correctly inside an RTL paragraph.
3. **Text layer** — the source string round-trips out of the PDF (searchable, copy-pastable, auditable).
4. **Determinism** — two renders of one input are byte-identical (tests 26 and 29 depend on this).
5. **Operable** — runs headless in the container image, and in the Electron main process for
   single-document printing (D18: Windows drivers, no hardware code).

## What was actually run

All three candidates were built and run to completion on this host (Windows 11, Bun 1.4.2, Node
24.9.0). Six PDFs were produced (`spikes/pdf-engine/out/{typst,chromium,react-pdf}-{ltr,rtl}.pdf`,
committed alongside this ADR, each with a matching `.png` rasterized by the committed
`spikes/pdf-engine/rasterize.ts`) and inspected three ways: `bun run --cwd spikes/pdf-engine inspect`
(run twice, for determinism), a byte-level diff between the two runs (to characterize *what*
differs when the hash doesn't match), and by reading the rasterized PNGs directly.

### Correction from this ADR's first draft

An earlier draft of this ADR concluded "no candidate passes." That conclusion was wrong, and the
review that caught it is recorded here because the reason matters for anyone re-running this spike
or its inspection tooling in future: **`pdfjs-dist`'s `getTextContent()` has no `/ActualText`
support.** `/ActualText` is the PDF-standard mechanism for exactly the problem this spike measures —
a shaped glyph cluster whose glyph identity differs from its source characters — and a PDF generator
can emit a fully correct `/ActualText` span while `getTextContent()` still returns glyph-derived
nonsense for it, because it never reads that span. `inspect.ts` originally used `getTextContent()`
for its round-trip probe and reported `0/3` for every one of the six PDFs. Decoding each file's
`/ActualText` spans directly (`pdftotext`, from poppler, which does honour them) shows this was a
property of the *extractor*, not of two of the three PDFs:

| file | raw `/ActualText` spans (own count, direct zlib-inflate + grep of every content stream) |
|---|---|
| `typst-rtl.pdf` | 43 |
| `chromium-rtl.pdf` | 117 |
| `react-pdf-rtl.pdf` | 0 |

`inspect.ts` now shells out to `pdftotext` instead of using `pdfjs-dist`'s text layer for the
round-trip check (pdfjs-dist is still used for the `first-item-x` bidi signal, which is a geometry
question and unaffected by this). The probe/direction pairing was also wrong in the first draft:
all three probes are Arabic, but every candidate's `-ltr.pdf` renders `nameEn`/`descriptionEn`
(Latin) — scoring an Arabic probe against an `-ltr.pdf` was guaranteed to read `0/3` and proved
nothing. Arabic probes now score only the `-rtl.pdf` renders; Latin probes were added for the
`-ltr.pdf` renders.

### Host-specific fixes (environment limits, recorded not faked)

- **Typst's Windows path handling (render.ts).** `sys.inputs.fixture` is read through Typst's
  sandboxed virtual filesystem, not the OS filesystem directly. Typst 0.15.1 rejects any path
  containing a drive-letter component (`error: path contains invalid component "C:"`), including a
  root-relative (`/…`) value combined with `--root`. Fix: invoke `typst compile --root .` with `cwd`
  set to `spikes/pdf-engine` and pass the fixture as `../../fixture/invoice.json`, relative to
  `invoice.typ`'s own directory. This is a Windows-CLI-argument workaround, not a change to what is
  being tested.
- **No Noto on this host, in a format each engine can read (fonts/, render.ts).** This machine has
  no Noto Sans / Noto Sans Arabic installed as a system font, and the npm `@fontsource/*` packages
  (installed for candidate C's `fontkit` loader) ship **only** `.woff`/`.woff2` — a container format
  Typst's font loader does not read. Fix: `.ttf` builds of the same two families were fetched from
  the upstream `google/fonts` repository (OFL-1.1 licensed; see `fonts/NOTICE.md` and `fonts/OFL.txt`,
  which now carries both families' copyright lines) into `spikes/pdf-engine/fonts/`, given to Typst
  via `--font-path` and to Chromium via an inlined base64 `@font-face`, holding the font constant
  across candidates A and B (candidate C already had its own copy via `@fontsource`). **This choice
  of font turned out to matter to the result** — see "Typst's text-layer defect" below.
- **`inspect.ts`'s hash was computed after the buffer was already gone.** As given in the brief,
  `sha256` is computed from `bytes` *after* `getDocument({ data: bytes })` runs. Under both Bun and
  Node, `pdfjs-dist` 6.3.289 detaches/zeroes the typed array it was handed as a side effect of
  parsing (confirmed: `bytes.length` goes from the real file size to `0` after the call), so every
  file's reported digest was silently the SHA-256 of an empty buffer regardless of content. Fixed by
  moving the `createHash(...)` call before `getDocument(...)`.
- **Typst's determinism needed one flag.** `typst compile --creation-timestamp 1700000000` pins the
  embedded creation/XMP dates to a fixed instant; without it, two otherwise byte-identical compiles
  differ only in that timestamp. `render.ts` now passes this flag. Verified over four independent
  `render` invocations in this session: `typst-ltr.pdf` and `typst-rtl.pdf` produced the exact same
  `sha256` (`6cc2af70824e…` / `16015bac90cf…`) every time.

## Measurements

`bun run --cwd spikes/pdf-engine render && bun run --cwd spikes/pdf-engine inspect` (the six PDFs
committed alongside this ADR are exactly this run's output):

| file | text-round-trip | tofu | first-item-x | sha256 (committed) | sha256 (independent 2nd run) |
|---|---|---|---|---|---|
| chromium-ltr.pdf | 3/3 | no | 63 | `ed5205989056` | `6fb2108073b3` |
| chromium-rtl.pdf | 3/3 | no | 417 | `d83b6aedb586` | `1d4e60623aa4` |
| react-pdf-ltr.pdf | 2/3 | no | 40 | `92e3b7a4b5b7` | `3f6b120cd8c0` |
| react-pdf-rtl.pdf | 0/3 | no | **40** | `90ec4ead9c73` | `6dfea74a7dc6` |
| typst-ltr.pdf | 3/3 | no | 57 | `6cc2af70824e` | `6cc2af70824e` |
| typst-rtl.pdf | 0/3 | no | 457 | `16015bac90cf` | `16015bac90cf` |

`first-item-x`: on both Typst and Chromium, the `-rtl.pdf` value (417, 457) sits near the page's
right edge and the matching `-ltr.pdf` value (63, 57) near the left — the expected bidi signature.
**react-pdf-rtl.pdf's first-item-x is 40 — the same as its own `-ltr` twin, not mirrored** — the
page heading and meta line stay left-anchored under `dir="rtl"`; only the flex-*row* children (the
party names, the table) actually reorder, because the given candidate code only sets `direction` on
row-flex containers, not on the standalone heading/meta `Text` nodes.

**Determinism, byte-level.** Typst's `sha256` is now identical across every run in this session — a
plain pass, no caveat. Chromium's and react-pdf's are not, but a byte diff (masking known volatile
fields) shows both are content-identical run-to-run:

| file pair | bytes differing after masking | what differs |
|---|---|---|
| chromium-{run A, run B} | 0 | `/CreationDate`, `/ModDate` only |
| react-pdf-{run A, run B} | 0 | one embedded `(D:…Z)` date string, plus a random-looking `/ID` pair |

So Chromium and react-pdf are marked `pass*` below (content-identical; raw `sha256` differs only
because of an embedded generation timestamp and, for react-pdf, a per-render document `/ID`) —
5A's test 26 / 8B's test 29 will need to normalize or strip those two fields before comparing bytes
for whichever of these two is ever used. **Typst needs no such normalization**: `--creation-timestamp`
already makes it byte-identical outright.

## Text layer, corrected

**Chromium's text layer is complete and correct, independent of which extractor reads it.** Its
content stream carries 117 `/ActualText` spans (own count, confirmed by inflating every content
stream in `chromium-rtl.pdf` and counting `/ActualText` occurrences directly, matching the review's
independent count). `pdftotext` — which honours `/ActualText`, unlike `pdfjs-dist`'s text layer —
recovers all three Arabic probes exactly, in both directions: `3/3` on `chromium-ltr.pdf` and
`chromium-rtl.pdf`. The Presentation-Forms glyph identities visible via `pdfjs-dist`'s raw
`getTextContent()` (short, `\u0000`-separated fragments, matching this ADR's first draft) are real,
but they describe the *shown glyphs*, which is not what a PDF's text layer is for — the
`/ActualText` span alongside them is what a compliant extractor is supposed to read, and it is
correct.

**Typst's text-layer defect is real, but font-specific, not an engine limitation.** `typst-rtl.pdf`
carries 43 `/ActualText` spans, but `pdftotext` recovers `0/3` — every dotted Arabic letter is
duplicated in the extracted text (e.g. `شركة` → `ششركة`-style doubling). The mechanism: Noto Sans
Arabic decomposes a dotted letter into a base glyph plus separate combining-mark glyph(s) for its
dot(s), and Typst applies the cluster's `/ActualText` to *both* the base glyph and the mark
glyph(s) instead of once per cluster — so every dotted letter's source text is emitted twice. This
was verified directly, not just diagnosed: re-running the exact same `candidates/typst/invoice.typ`
template with only the font changed from `("Noto Sans Arabic", "Noto Sans")` to `("Tahoma",
"Tahoma")` (Tahoma is already present on this host — `typst fonts` lists it) produces a **clean
`3/3` round-trip with no duplication**, confirmed by direct inspection of `pdftotext`'s output. The
defect is a Typst × Noto-Sans-Arabic interaction, not a Typst limitation — but it *is* a real defect
of the specific engine+font combination this spike built, fonts/`NOTICE.md`'s rationale
notwithstanding: holding the font constant across candidates was the right call for measuring the
*engines*' shaping and bidi, but it is exactly the variable that decides Typst's text-layer score.
Typst paired with a different Arabic face (Tahoma, verified above) would pass this criterion too —
but that pairing is not what this spike shipped or measured as a candidate. Contracts §5 hazard 30
means this ADR's *verdict* is not re-litigated — the chosen engine does not change on a whim, and
nobody re-runs this spike to argue Typst should have won instead — but it does not freeze the
register `app.print_template.engine` feeds forever: that register can still be amended by the
ordinary process the Alternatives section below describes (a contracts amendment, a
CHECK-widening migration, a 7A adapter), once the font question is settled. The finding is recorded
so the choice below is understood to be about the font this spike measured, not a ceiling on what
Typst could do with a different one.

**`@react-pdf/renderer` has no `/ActualText` at all (0 spans, confirmed)** — its poor round-trip
score is a real, unmitigated defect of the candidate as built, not a measurement artifact.
Additionally, its extracted text is corrupted by the layout defect described below: `pdftotext` on
`react-pdf-ltr.pdf` returns `Tax (example 860.7200\nrate):812.0000\n48.7200` — the words "Tax
(example" and "rate):" are split apart with unrelated overlapping numbers interleaved, because
overlapping views are extracted in paint order, not reading order. This is why react-pdf-ltr.pdf's
round-trip is `2/3` rather than `3/3`: the third Latin probe (`"Tax (example rate)"`) is a casualty
of the same defect discussed next, not a shaping issue.

## Visual inspection (all six PDFs, both directions)

Screenshots of the rasterized pages (`spikes/pdf-engine/out/*.png`, committed; regenerate any time
with `bun run --cwd spikes/pdf-engine rasterize`) were reviewed directly, not just the numeric table:

- **Typst** — `المثال`/`الأمين` show a correctly joined lam-alef ligature; contextual letterforms
  are correct throughout; the RTL heading, party block and table are fully mirrored to the right;
  `التوصيل إلى بينانج — طراز XR-9` reads with `XR-9` correctly embedded left-to-right inside the
  RTL sentence and the em dash in the right place. No visible defect — the text-layer duplication
  above is invisible on the page; it only affects what a `/ActualText`-aware extractor recovers.
- **Chromium print-to-PDF** — same result as Typst: correct ligature, correct contextual forms, full
  RTL mirroring, correct mixed-run ordering, correctly mirrored parentheses. No visible defect, and
  (per the correction above) no hidden text-layer defect either.
- **`@react-pdf/renderer`** — three separate, reproducible defects:
  1. **Shaping fails visibly.** The RTL heading and the seller/line-item Arabic text show dropped or
     substituted initial letterforms (e.g. the heading's leading `ف` and the seller name's leading
     `ش` do not render as themselves).
  2. **Bidi mirroring is partial**, and one specific mis-ordering was confirmed by decoding the
     extracted string's actual character sequence (not just eyeballing it): on the mixed-script
     line, the logical order that comes out is `"XR-9"` + `"التوصيل إلى بينانج"` + `"—"` +
     `"طراز"` — the Latin/digit run is hoisted to the very front of the logical string instead of
     staying at the end, after `"طراز"`, where the source text puts it. Confirmed by dumping the
     line's codepoints with directional-formatting characters (LRE/RLE/PDF) labelled. A second,
     independent observation of this same line described it differently ("XR-9 lands between `—`
     and `طراز`"); the two may be describing different layers (raw content-stream/glyph order versus
     `pdftotext`'s logical reconstruction, which is what the codepoint dump above measured) rather
     than disagreeing outright. This is left unreconciled here — it does not change react-pdf's
     verdict either way, since shaping and bidi already fail independently of this specific finding.
  3. **The totals block overlaps itself**, in *both* `ltr` and `rtl` renders — the subtotal, tax
     line and bold total print on top of one another instead of stacking as separate lines, and (per
     "Text layer, corrected" above) this corrupts the extracted text too. **Root cause, identified
     precisely, not just observed:** `styles.figure` (`candidates/react-pdf/invoice.tsx:56`,
     `{ flex: 1, textAlign: "right" }`) is written for *row* children (the table cells, where
     `flex: 1` distributes width across siblings) and is reused, in the given candidate code, on the
     *column-stacked* children of `styles.totals`. In an auto-height column, `flex: 1` sets each
     child's flex-basis to `0`, collapsing every child to zero height so they all paint at the same
     y-position. This is **a bug in this specific candidate's styling, not a fundamental
     `@react-pdf/renderer`/Yoga defect** — it is not evidence that the library's `Document`/`View`/
     `Text` model is unusable for production, only that this reused style is wrong for this layout.
  It does not change react-pdf's verdict: shaping and bidi fail on their own, independent of the
  totals bug.
- No candidate showed tofu (missing-glyph boxes) once each was given a real Arabic-capable font —
  consistent with `tofu: no` for all six files above.

## Verdict table

| Candidate | `engine` code | 1 Shaping | 2 Bidi | 3 Text layer | 4 Determinism | 5 Operable | Verdict |
|---|---|---|---|---|---|---|---|
| Typst | `typst` | pass | pass | **fail** (font-specific, see above) | pass | reasoned, not measured | fail |
| Chromium print-to-PDF | `chromium` | pass | pass | pass | pass* | reasoned, not measured | **pass — chosen** |
| `@react-pdf/renderer` | `react-pdf` | **fail** | **fail** | **fail** | pass* | reasoned, not measured | fail |

`pass*` — content-identical across independent renders; raw `sha256` differs only because of an
embedded generation timestamp (Chromium) or timestamp + random `/ID` (react-pdf). **`5 Operable` was
not empirically exercised by this spike for any candidate** — nothing here builds the Linux
container image or drives Electron's `webContents.printToPDF` from the main process — so these
cells are reasoned, not measured, and are marked as such rather than a plain `pass`, per this ADR's
own "never fake a score" rule. The reasoning: Chromium print-to-PDF is *literally* the engine
`webContents.printToPDF` already uses (no second dependency for the desktop path, per D18), and a
Playwright/Chromium binary running headless in a Linux container (as this spike already does, on
Windows, via Playwright) is a well-established deployment pattern. Typst runs headless with no
display or driver dependency but needs its own binary bundled per platform (not an npm dependency;
installed here via `winget install --id Typst.Typst`) plus, per the font finding above, a real
Arabic `.ttf` supplied out-of-band. `@react-pdf/renderer` needs no native binary and no browser at
all — reasoned to be the lightest container image of the three — but does not clear criteria 1 or 2.

## Decision

**The chosen engine is Chromium print-to-PDF (`chromium`).** It is the only candidate that passes
every criterion this spike actually measured — shaping, bidi, text layer (including the
`/ActualText` correction above), and determinism (content-identical; timestamp-only byte diff) —
and its operability is the most soundly reasoned of the three: it is not a new dependency at all for
the Electron desktop print path (D18), since `webContents.printToPDF` runs the same engine, and a
headless-Chromium container image is what this spike itself has been running throughout.

**The closed value set of `app.print_template.engine` (contracts §4.5.9) is `{chromium}`.** 2C's
migration 0026 writes that CHECK from this table; 7A ships the `chromium` `renderReport` adapter.

Typst came close — it passes shaping, bidi and (with `--creation-timestamp`) determinism outright,
and its text-layer defect is demonstrably about the specific font paired with it in this spike, not
about the engine itself. It is recorded as a near-miss, not a second value in the set — see
Alternatives below for what was measured and what admitting it later would cost.
`@react-pdf/renderer` fails shaping and bidi visibly, independent of any font choice, and its
candidate code additionally has a self-overlapping totals block traced to a specific reused style
(`invoice.tsx:56`); it is not competitive here regardless of its lighter deployment footprint.

## Alternatives

**Typst, with a different Arabic face, was measured viable — the value set stays `{chromium}`
anyway, and here is the reasoning so a future reader does not have to re-derive it.**

- **Viable, not just close.** With Tahoma substituted for Noto Sans Arabic, Typst produced a clean
  `3/3` text-layer round-trip with no duplication — verified independently twice: once by the
  review that caught this ADR's original `/ActualText` measurement gap, and once more by
  re-running `candidates/typst/invoice.typ` with only the font changed, directly in this session.
  Its determinism is a plain pass with `--creation-timestamp`; its shaping and bidi already passed
  with either font. Chromium is additionally the D18-friendly answer on its own merits — Electron's
  `webContents.printToPDF` is the same engine, so the desktop app carries no second renderer for
  the single-document print path — but Typst was not rejected for being *worse*; it was excluded
  for costing something Chromium does not.
- **The failure with the font this spike shipped is specific and named, not a shrug.** With Noto
  Sans Arabic, Typst applies a shaped cluster's `/ActualText` to both the base glyph and its
  combining-mark glyph(s) — Noto Sans Arabic decomposes a dotted letter's dot(s) into separate mark
  glyphs — so every dotted letter's source text is emitted twice. This is a Typst ×
  Noto-Sans-Arabic interaction, not a Typst limitation: it persists with a real, static `.ttf`
  build of that font (`fonts/NotoSansArabic.ttf`, committed) and vanishes with Tahoma.
- **Admitting `typst` to the value set today is not free, which is why it stays out.** 7A receives
  one `renderReport` adapter per code in `app.print_template.engine` (contracts §4.11.2): adding
  `typst` today would oblige a second adapter and its tests for an engine nothing currently needs.
- **Admitting it later is an ordinary, bounded cost, not a dead end.** Contracts hazard 30 says this
  ADR is not re-opened; it does not freeze the register forever. If a future slice needs Typst,
  admitting it costs: a contracts amendment widening `app.print_template.engine`'s documented set, a
  migration widening the column's CHECK constraint, and a 7A `renderReport` adapter for `typst`. The
  font question must be settled first — Tahoma is confirmed to work; Noto Sans Arabic, in this
  exact static-font configuration, is confirmed not to.

## Consequences

- 2C, 7A and 8D consume `chromium` as the engine; none of them re-evaluates engines (contracts §5
  hazard 30).
- 7A's `renderReport` adapter for `chromium` (and 5A's test 26 / 8B's test 29, wherever they compare
  rendered output byte-for-byte) must normalize or strip `/CreationDate` and `/ModDate` before
  comparing bytes — Chromium's output is content-identical run-to-run but not literally
  byte-identical, per the determinism measurements above.
- The spike stays at `spikes/pdf-engine/` as this ADR's evidence and is re-runnable when a candidate
  releases a new version: `bun install` at the repo root, then `bun install --cwd spikes/pdf-engine`,
  install `typst` and `pdftotext` (poppler) separately (neither is an npm package — see `render.ts`
  and `inspect.ts` for exact install commands), then `bun run --cwd spikes/pdf-engine render`,
  `... inspect`, and `... rasterize` (the last needs the `@napi-rs/canvas` devDependency, already
  declared). `spikes/pdf-engine/fonts/` documents why real `.ttf` Noto builds are checked in
  alongside the npm-installed `.woff`/`.woff2` copies, and why that font choice specifically
  affected Typst's (unused) text-layer score.
- No LHDN or MyInvois field appears in the fixture; e-invoicing formats arrive with 5B's ADR 0051.
