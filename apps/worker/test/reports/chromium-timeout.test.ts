import { afterEach, describe, expect, it, vi } from "vitest";

// CON-08: `page.pdf()` takes no timeout of its own — Playwright passes kNoTimeout to the protocol call — so
// the context default never bounded it, and a print layout that stalled held its context (and, in the API,
// the request) for ever. A fake Playwright whose pdf() never settles stands in for that stall.
const { closed, launched } = vi.hoisted(() => ({
  closed: vi.fn(() => Promise.resolve()),
  launched: [] as { chromiumSandbox?: boolean; args?: string[] }[],
}));
vi.mock("playwright", () => {
  const page = {
    setContent: () => Promise.resolve(),
    emulateMedia: () => Promise.resolve(),
    pdf: () => new Promise<Buffer>(() => undefined),
  };
  const context = {
    setDefaultTimeout: () => undefined,
    route: () => Promise.resolve(),
    newPage: () => Promise.resolve(page),
    close: closed,
  };
  const browser = {
    newContext: () => Promise.resolve(context),
    on: () => undefined,
    close: () => Promise.resolve(),
  };
  return {
    chromium: {
      launch: (options: { chromiumSandbox?: boolean; args?: string[] }) => {
        launched.push(options);
        return Promise.resolve(browser);
      },
      executablePath: () => "",
    },
  };
});

const {
  chromiumReportEngine,
  REPORT_RENDER_TIMEOUT_MS,
  closeReportChromium,
  chromiumLaunchOptions,
} = await import("../../src/reports/engines/chromium");

describe("the Chromium engine bounds page.pdf() (CON-08)", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeReportChromium();
  });

  it("rejects a print that never finishes once the render timeout passes, and closes its context", async () => {
    vi.useFakeTimers();
    const outcome = chromiumReportEngine
      .render("<!doctype html><p>stalls</p>", {
        paper: "A4",
        orientation: "portrait",
        dir: "ltr",
      } as never)
      .then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    await vi.advanceTimersByTimeAsync(REPORT_RENDER_TIMEOUT_MS + 1);
    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatch(
      /did not finish/,
    );
    expect(closed).toHaveBeenCalled();
  });
});

// ORCH-01: Playwright passes `--no-sandbox` unless a launch sets `chromiumSandbox: true`, so the sandbox
// is decided by `CHROMIUM_SANDBOX` alone — never by the process's uid — and the launch carries the decision.
describe("the Chromium sandbox is an explicit choice (ORCH-01)", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeReportChromium();
  });

  it("is off unless CHROMIUM_SANDBOX is exactly 1, and never adds --no-sandbox itself", () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const options = chromiumLaunchOptions(value === undefined ? {} : { CHROMIUM_SANDBOX: value });
      expect(options.chromiumSandbox).toBe(false);
      expect(options.args).not.toContain("--no-sandbox");
    }
    const on = chromiumLaunchOptions({ CHROMIUM_SANDBOX: "1" });
    expect(on.chromiumSandbox).toBe(true);
    expect(on.args).not.toContain("--no-sandbox");
  });

  it.each([
    ["0", false],
    ["1", true],
  ])("CHROMIUM_SANDBOX=%s launches with chromiumSandbox: %s", async (value, expected) => {
    vi.stubEnv("CHROMIUM_SANDBOX", value);
    vi.useFakeTimers();
    const outcome = chromiumReportEngine
      .render("<!doctype html><p>x</p>", {
        paper: "A4",
        orientation: "portrait",
        dir: "ltr",
      } as never)
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(REPORT_RENDER_TIMEOUT_MS + 1);
    await outcome;
    expect(launched.at(-1)?.chromiumSandbox).toBe(expected);
  });
});
