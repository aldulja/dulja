# Fonts used by this spike

`NotoSansArabic.ttf` and `NotoSans.ttf` are variable TrueType builds of Google's Noto Sans Arabic
and Noto Sans, fetched from the upstream `google/fonts` repository (the same font family the
`@fontsource/noto-sans-arabic` and `@fontsource/noto-sans` npm packages repackage):

- https://raw.githubusercontent.com/google/fonts/main/ofl/notosansarabic/NotoSansArabic%5Bwdth%2Cwght%5D.ttf
- https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf

Both are licensed under the SIL Open Font License 1.1; `OFL.txt` in this directory carries both
fonts' copyright lines (they differ; the license body is otherwise identical between them).

## Why these are here instead of `node_modules`

`@fontsource/noto-sans-arabic` and `@fontsource/noto-sans` (installed via `bun add`, see
`spikes/pdf-engine/package.json`) ship **only** `.woff`/`.woff2` files — no `.ttf`/`.otf`. That is
fine for candidate C (`@react-pdf/renderer`'s `fontkit` loader reads `.woff` directly) and fine for
candidate B (a browser reads woff natively), but Typst's font loader (candidate A) only reads
raw SFNT containers (`.ttf`/`.otf`/`.ttc`) — `typst fonts --font-path node_modules/@fontsource`
lists nothing. Windows also does not have Noto installed as a system font on this host
(`typst fonts` lists "Arabic Typesetting", "Tahoma", "Simplified/Traditional Arabic", but not
Noto), so without this directory Typst silently falls back to its own embedded default font
family, which has no Arabic glyph coverage at all — a font-availability artifact of this host,
not a finding about Typst's shaper. `render.ts` also inlines `NotoSansArabic.ttf` as a base64
`@font-face` into candidate B's HTML for the same reason: to hold the font constant across all
three candidates so the comparison measures the *engine*, not which typeface happened to be
preinstalled on the machine that ran the spike. See ADR 0016 for how this is recorded.
