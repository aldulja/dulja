import { chromium, type Browser } from "playwright";
import type { PdfEngine } from "./index";

/** `print_template.paper` → Playwright's page vocabulary. `receipt` is an 80 mm continuous roll. */
const PAGE: Readonly<Record<string, { format?: "A4" | "A5"; width?: string; height?: string }>> = {
  A4: { format: "A4" },
  A5: { format: "A5" },
  receipt: { width: "80mm", height: "297mm" },
};

/** A render that has not finished in this long is failed, not waited for: a template can no longer reach
 *  the network (below), so the only thing left to wait on is a pathological layout. */
export const RENDER_TIMEOUT_MS = 15_000;

/**
 * Optional, like `SENTRY_DSN` and `OTEL_EXPORTER_OTLP_ENDPOINT`: a host that already carries a Chromium
 * (the container image, a CI runner with a pinned browser cache) names its binary and Playwright downloads
 * nothing. `readConfig` reads `CHROMIUM_EXECUTABLE_PATH` and `index.ts` hands it here; the environment
 * fallback is for a test process, which never runs `index.ts`. Unset, Playwright launches the build its own
 * version pins.
 */
let configuredPath: string | null = null;
export function configureChromium(opts: { executablePath: string | null }): void {
  configuredPath = opts.executablePath;
}
function executablePath(): string | undefined {
  const path = configuredPath ?? process.env["CHROMIUM_EXECUTABLE_PATH"] ?? "";
  return path === "" ? undefined : path;
}

/**
 * The sandbox is an explicit choice, `CHROMIUM_SANDBOX` (ORCH-01). Playwright passes `--no-sandbox` to
 * Chromium on every launch unless `chromiumSandbox: true` is set, so the sandbox was OFF everywhere — not
 * only as root, as this comment used to say. `CHROMIUM_SANDBOX=1` turns it on; anything else leaves it off,
 * which is what every image so far has run. With it on, Chromium refuses to start as root, so the image
 * must run as a non-root user with the namespaces the sandbox needs: see `docs/runbooks/deploy.md`,
 * "Runtime image". Whether production turns it on is the owner's decision.
 */
export function chromiumLaunchOptions(env: NodeJS.ProcessEnv = process.env): {
  args: string[];
  chromiumSandbox: boolean;
} {
  return { args: ["--font-render-hinting=none"], chromiumSandbox: env["CHROMIUM_SANDBOX"] === "1" };
}

/**
 * One browser per process, launched on first use. `page.pdf()` and Electron's `webContents.printToPDF`
 * are the same engine (ADR 0016 criterion 5), so the desktop app prints a single document without a
 * second dependency (D18). A launch that fails clears itself so the next print retries, and a browser that
 * crashes or is killed clears itself the same way — one bad launch must never make every later print in
 * the process fail until a restart.
 */
let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

function shared(): Promise<Browser> {
  if (browser) return Promise.resolve(browser);
  const path = executablePath();
  launching ??= chromium
    .launch({
      ...chromiumLaunchOptions(),
      ...(path === undefined ? {} : { executablePath: path }),
    })
    .then((b) => {
      browser = b;
      launching = null;
      b.on("disconnected", () => {
        if (browser === b) browser = null;
      });
      return b;
    })
    .catch((e: unknown) => {
      launching = null;
      throw e;
    });
  return launching;
}

export async function closeChromium(): Promise<void> {
  const b = browser ?? (launching ? await launching.catch(() => null) : null);
  browser = null;
  launching = null;
  await b?.close();
}

/**
 * `page.pdf()` takes no timeout of its own — Playwright passes `kNoTimeout` to the protocol call, so the
 * context default never reaches it (CON-08). The print is raced against the same bound; on expiry the
 * render rejects and its `finally` closes the context, which ends the print in Chromium.
 */
async function printWithin<T>(print: Promise<T>, ms: number): Promise<T> {
  // The losing print rejects once its context closes; nobody awaits it then.
  print.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      print,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`page.pdf() did not finish within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const chromiumEngine: PdfEngine = {
  code: "chromium",
  async render(source, opts) {
    // A template is TENANT DATA and is rendered as such: scripts off, and every network request the page
    // would make is aborted. `setContent` fetches nothing on its own, but an `<img src>`, a stylesheet or
    // a `@font-face url()` inside the body would otherwise let a template reach whatever the API container
    // can reach (SSRF), carry the document's contents out, or make two renders differ (ADR 0016 criterion 4).
    // Each render gets its own context so nothing persists between tenants or documents.
    const context = await (await shared()).newContext({ javaScriptEnabled: false });
    try {
      // One bound for every step below: the context default for setContent and emulateMedia, and
      // `printWithin` for pdf(), which the default does not reach.
      context.setDefaultTimeout(RENDER_TIMEOUT_MS);
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      const page = await context.newPage();
      await page.setContent(source, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      const size = PAGE[opts.paper] ?? PAGE["A4"]!;
      // `dir` is already on the template's <html> element (the body reads `{{ dir }}`); passing it again
      // would let a template and a request disagree. The parameter stays in the interface because a
      // text-driven engine without a document model (Typst) would need it.
      return new Uint8Array(
        await printWithin(
          page.pdf({ ...size, printBackground: true, preferCSSPageSize: false }),
          RENDER_TIMEOUT_MS,
        ),
      );
    } finally {
      await context.close();
    }
  },
};
