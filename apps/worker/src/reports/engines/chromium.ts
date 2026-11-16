import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import type { ReportPdfEngine } from "./index";

/** §4.5.9's paper vocabulary → Playwright's page vocabulary. `receipt` is an 80 mm continuous roll. */
const PAGE: Readonly<Record<string, { format?: "A4" | "A5"; width?: string; height?: string }>> = {
  A4: { format: "A4" },
  A5: { format: "A5" },
  receipt: { width: "80mm", height: "297mm" },
};

/** A report is larger than a single printed document, so its bound is longer than 2C's 15 s; it is still a
 *  bound — the source can reach no network, so the only thing left to wait on is the layout itself. */
export const REPORT_RENDER_TIMEOUT_MS = 60_000;

/**
 * Optional, exactly as for `apps/api`'s print engine: a host that already carries a Chromium (the container
 * image, a CI runner with a pinned browser cache) names its binary in `CHROMIUM_EXECUTABLE_PATH` (§3.11 —
 * `containerSecrets` passes it to the worker as well) and Playwright downloads nothing. Unset, Playwright
 * launches the build its own version pins.
 */
function executablePath(): string | undefined {
  const path = process.env["CHROMIUM_EXECUTABLE_PATH"] ?? "";
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
 * One browser per process, launched on first use. A launch that fails clears itself so the next render
 * retries, and a browser that crashes or is killed clears itself the same way — one bad launch must never
 * fail every later report until a restart.
 */
let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

function shared(): Promise<Browser> {
  if (browser) return Promise.resolve(browser);
  const path = executablePath();
  launching ??= chromium
    .launch({ ...chromiumLaunchOptions(), ...(path === undefined ? {} : { executablePath: path }) })
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

export async function closeReportChromium(): Promise<void> {
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

export const chromiumReportEngine: ReportPdfEngine = {
  code: "chromium",
  available() {
    try {
      const path = executablePath() ?? chromium.executablePath();
      return Promise.resolve(path.length > 0 && existsSync(path));
    } catch {
      return Promise.resolve(false);
    }
  },
  async render(source, opts) {
    // The same posture as 2C's print engine: scripts off and every request the page would make aborted, so
    // a label or a cell value can reach nothing and two renders of one report cannot differ by a fetch.
    // `reportToHtmlSource` references no URL at all; this is the guard that keeps it true. Each render gets
    // its own context so nothing persists between tenants or reports.
    const context = await (await shared()).newContext({ javaScriptEnabled: false });
    try {
      context.setDefaultTimeout(REPORT_RENDER_TIMEOUT_MS);
      await context.route("**/*", (route) => route.abort("blockedbyclient"));
      const page = await context.newPage();
      await page.setContent(source, { waitUntil: "load" });
      await page.emulateMedia({ media: "print" });
      const size = PAGE[opts.paper] ?? PAGE["A4"]!;
      // `dir` is already on the <html> element `reportToHtmlSource` emits; passing it again would let the
      // source and the request disagree. A receipt roll has no landscape form.
      return new Uint8Array(
        await printWithin(
          page.pdf({
            ...size,
            landscape: opts.orientation === "landscape" && opts.paper !== "receipt",
            printBackground: true,
            preferCSSPageSize: false,
          }),
          REPORT_RENDER_TIMEOUT_MS,
        ),
      );
    } finally {
      await context.close();
    }
  },
};
