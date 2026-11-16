import { describe, expect, it } from "vitest";
import { preloadFaultAction } from "../src/preload-guard";

const PRELOAD = "C:\\app\\resources\\app.asar\\dist\\preload.js";

describe("preloadFaultAction", () => {
  it("names the path in both faults, so the message identifies the file that is wrong", () => {
    expect(preloadFaultAction({ kind: "missing", preloadPath: PRELOAD }, true).message).toContain(
      PRELOAD,
    );
    expect(
      preloadFaultAction({ kind: "error", preloadPath: PRELOAD, detail: "boom" }, true).message,
    ).toContain(PRELOAD);
  });

  it("distinguishes an absent file from one that ran and threw, and carries the thrown detail", () => {
    const missing = preloadFaultAction({ kind: "missing", preloadPath: PRELOAD }, false);
    const failed = preloadFaultAction(
      { kind: "error", preloadPath: PRELOAD, detail: "Cannot find module 'electron'" },
      false,
    );
    expect(missing.message).not.toBe(failed.message);
    expect(missing.message).toMatch(/missing/i);
    expect(failed.message).toContain("Cannot find module 'electron'");
  });

  it("is fatal either way — a bridgeless renderer is DoD 0.13's failure, not a degraded mode", () => {
    for (const isPackaged of [true, false]) {
      expect(
        preloadFaultAction({ kind: "missing", preloadPath: PRELOAD }, isPackaged).exitCode,
      ).toBe(1);
      expect(
        preloadFaultAction({ kind: "error", preloadPath: PRELOAD, detail: "x" }, isPackaged)
          .exitCode,
      ).toBe(1);
    }
  });

  it("shows a dialog only when packaged: a modal box would hang CI, and stderr is unread by a user", () => {
    expect(preloadFaultAction({ kind: "missing", preloadPath: PRELOAD }, true).showDialog).toBe(
      true,
    );
    expect(preloadFaultAction({ kind: "missing", preloadPath: PRELOAD }, false).showDialog).toBe(
      false,
    );
    expect(
      preloadFaultAction({ kind: "error", preloadPath: PRELOAD, detail: "x" }, true).showDialog,
    ).toBe(true);
    expect(
      preloadFaultAction({ kind: "error", preloadPath: PRELOAD, detail: "x" }, false).showDialog,
    ).toBe(false);
  });
});
