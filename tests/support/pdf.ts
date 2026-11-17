import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const STRONG_LTR = /[A-Za-z0-9]/;

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Cluster {
  text: string;
  arabic: boolean;
  strongLtr: boolean;
}

/** Items on one baseline, left to right, merged wherever no visible gap separates them. */
function clustersOf(line: Item[]): Cluster[] {
  const clusters: Item[][] = [];
  for (const item of line) {
    const current = clusters.at(-1);
    const last = current?.at(-1);
    if (current && last && item.x - (last.x + last.width) < 0.15 * Math.max(last.height, 1)) {
      current.push(item);
    } else clusters.push([item]);
  }
  return clusters.map((items) => {
    // Within an item the text is already logical; a shaped Arabic run arrives one glyph per item in
    // VISUAL order, so an Arabic cluster is read right to left to recover the letters as written.
    const arabic = items.some((i) => ARABIC.test(i.str));
    const ordered = arabic ? items.toReversed() : items;
    const text = ordered
      .map((i) => i.str)
      .join("")
      .normalize("NFKC")
      .trim();
    return { text, arabic, strongLtr: !arabic && STRONG_LTR.test(text) };
  });
}

/**
 * A right-to-left line is read right to left, except for a run of left-to-right clusters — Latin words,
 * numbers, and the neutral punctuation BETWEEN two of them — which keeps its own order (the bidi rule,
 * applied to whole clusters).
 */
function logicalOrder(clusters: Cluster[]): Cluster[] {
  if (!clusters.some((c) => c.arabic)) return clusters;
  const reversed = clusters.toReversed();
  const out: Cluster[] = [];
  let i = 0;
  while (i < reversed.length) {
    if (!reversed[i]!.strongLtr) {
      out.push(reversed[i]!);
      i += 1;
      continue;
    }
    // Extend over strong-LTR clusters and neutrals that sit between two of them.
    let end = i;
    let j = i + 1;
    while (j < reversed.length && !reversed[j]!.arabic) {
      if (reversed[j]!.strongLtr) end = j;
      j += 1;
    }
    out.push(...reversed.slice(i, end + 1).toReversed());
    i = end + 1;
  }
  return out;
}

/**
 * The one test-side PDF reader (contracts §4.17.1): the text of page 1 as LINES in reading order, each
 * line's runs joined with one space. `useSystemFonts` lets the Arabic faces resolve so the text layer is
 * real text rather than glyph ids — which is what test 23 and LEGACY-085 assert on.
 *
 * Three facts ADR 0016 measured shape this function. `getDocument` detaches the array it is handed, so the
 * caller's bytes are copied first. pdfjs's `getTextContent()` reads no `/ActualText`, so a shaped Arabic
 * run comes back as Presentation-Forms code points (U+FB50–U+FEFF) rather than the letters the template
 * held; NFKC folds every presentation form and the lam-alef ligature back to base letters. And those runs
 * arrive one glyph per item in visual order, so items are re-grouped by baseline and position and an
 * Arabic run is read right to left. The digits and Latin text are unaffected by any of it.
 */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const content = await (await doc.getPage(1)).getTextContent();
    const items: Item[] = [];
    for (const raw of content.items) {
      if (!("str" in raw) || raw.str.trim().length === 0) continue;
      items.push({
        str: raw.str,
        x: raw.transform[4]!,
        y: raw.transform[5]!,
        width: raw.width,
        height: raw.height,
      });
    }
    // Lines: top of the page first (PDF y grows upward), items left to right within a baseline.
    const lines: Item[][] = [];
    for (const item of items.toSorted((p, q) => q.y - p.y || p.x - q.x)) {
      const line = lines.at(-1);
      if (line && Math.abs(line[0]!.y - item.y) <= 0.5 * Math.max(item.height, 1)) line.push(item);
      else lines.push([item]);
    }
    return lines
      .map((line) => line.toSorted((p, q) => p.x - q.x))
      .map((line) =>
        logicalOrder(clustersOf(line))
          .map((c) => c.text)
          .filter((t) => t.length > 0)
          .join(" "),
      )
      .filter((t) => t.length > 0);
  } finally {
    await task.destroy();
  }
}
