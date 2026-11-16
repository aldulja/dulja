import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = join(import.meta.dir, "out");
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixture/invoice.json"), "utf8"));

/**
 * Arabic probes are only meaningful against the `-rtl.pdf` renders: every candidate selects
 * nameEn/descriptionEn (Latin) when `dir` is "ltr", so scoring an Arabic probe against an
 * `-ltr.pdf` is guaranteed to read 0/3 and proves nothing about the candidate. Latin probes cover
 * the `-ltr.pdf` renders instead.
 */
const ARABIC_PROBES = [fixture.seller.nameAr, fixture.lines[2].descriptionAr, fixture.tax.labelAr] as string[];
const LATIN_PROBES = [fixture.seller.nameEn, fixture.lines[2].descriptionEn, fixture.tax.labelEn] as string[];

/**
 * NFKC composes/decomposes compatibility glyph variants consistently, and stripping bidi control
 * characters (LRE/RLE/PDF/LRM/RLM/isolates) and whitespace removes formatting a PDF's own
 * bidi-reordering text layer legitimately inserts (poppler's extractor emits explicit
 * embedding/pop marks around each direction run) without changing the actual character content
 * being compared.
 */
const normalize = (s: string) =>
  s.normalize("NFKC").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\s]+/g, "");

/**
 * pdfjs-dist's `getTextContent()` has no `/ActualText` support — grepping its worker bundle finds
 * `ActualText` only in annotation and struct-tree code, never in the plain text-extraction path.
 * `/ActualText` is the PDF-standard mechanism for exactly the case this spike is testing: a shaped
 * glyph cluster whose glyph identity differs from its source characters. A shaper can emit a fully
 * correct `/ActualText` span and `getTextContent()` will still return glyph-derived nonsense for
 * it. `pdftotext` (poppler) does honour `/ActualText`, so it is used here instead — this measures a
 * real property of the PDF file, independent of which extractor reads it.
 *
 * This makes `pdftotext` a second required external binary for this spike, alongside `typst` (see
 * render.ts): install it separately, e.g. `winget install --id oschwartz10612.Poppler` on Windows
 * or `brew install poppler` on macOS.
 */
const extractText = (path: string): string => {
  try {
    return execFileSync("pdftotext", [path, "-"], { encoding: "utf8" });
  } catch (cause) {
    throw new Error(
      `pdftotext not found or failed on ${path} — install poppler (winget install --id ` +
        `oschwartz10612.Poppler, or brew install poppler) to run text-layer inspection`,
      { cause },
    );
  }
};

for (const file of readdirSync(OUT).filter((f) => f.endsWith(".pdf")).sort()) {
  const bytes = new Uint8Array(readFileSync(join(OUT, file)));
  // The digest must be taken before `getDocument` runs: pdfjs-dist (both under Bun and under
  // Node) detaches/zeroes the buffer it was given as a side effect of parsing it, so hashing
  // afterward silently hashes an empty buffer and every file reports the same wrong digest.
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const pdf = await getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  // pdfjs-dist is still used for glyph position (the `first-item-x` bidi signal): that is a
  // geometry question, unaffected by whether the text layer's Unicode mapping is correct.
  const items = content.items as { str: string; transform: number[] }[];

  const rawText = extractText(join(OUT, file));
  const text = normalize(rawText);
  const probes = file.includes("-rtl.") ? ARABIC_PROBES : LATIN_PROBES;
  const roundTrips = probes.filter((p) => text.includes(normalize(p))).length;
  const tofu = /[�?]{2,}/.test(rawText);
  const firstX = items.find((i) => i.str.trim() !== "")?.transform[4] ?? 0;

  console.log(
    [
      file.padEnd(22),
      `text-round-trip ${roundTrips}/${probes.length}`,
      `tofu ${tofu ? "YES" : "no"}`,
      `first-item-x ${Math.round(Number(firstX))}`,
      `sha256 ${digest}`,
    ].join("  "),
  );
}
