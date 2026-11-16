// Rasterizes each out/*.pdf's first page to a PNG next to it, so the shaping and bidi criteria
// (spec:1132's "largest technical risk in reporting") can actually be looked at, not just scored —
// per the brief's Step 5 ("the machine cannot see a broken ligature that still round-trips").
// Neither Playwright nor Chromium's headless mode display a PDF (navigating to one downloads it
// instead of rendering it), so this renders through pdfjs-dist's canvas backend instead.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";

const OUT = join(import.meta.dir, "out");

for (const file of readdirSync(OUT).filter((f) => f.endsWith(".pdf")).sort()) {
  const bytes = new Uint8Array(readFileSync(join(OUT, file)));
  const pdf = await getDocument({ data: bytes }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
  const pngPath = join(OUT, file.replace(/\.pdf$/, ".png"));
  writeFileSync(pngPath, canvas.toBuffer("image/png"));
  console.log("wrote", pngPath);
}
