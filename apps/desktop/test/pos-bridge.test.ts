import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, POS_CHANNELS, type DuljaTillBridge } from "../src/bridge-types";
const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, value: "answer" })),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke },
}));
beforeEach(async () => {
  vi.resetModules();
  mocks.expose.mockClear();
  mocks.invoke.mockClear();
  await import("../src/preload-pos");
});
describe("POS build-output and sandbox bridge", () => {
  it("names all fourteen operations without back-office channel collisions", () => {
    expect(Object.keys(POS_CHANNELS).toSorted()).toEqual([
      "clock",
      "closeShift",
      "drain",
      "enrol",
      "login",
      "openShift",
      "priceCheck",
      "print",
      "pull",
      "receipt",
      "search",
      "sell",
      "status",
      "tender",
    ]);
    const existing = new Set<string>(Object.values(CHANNELS));
    for (const value of Object.values(POS_CHANNELS)) expect(existing.has(value)).toBe(false);
  });
  it("names every channel dulja:pos:<kebab-case method> and gives each one a handler in registerPosHandlers", () => {
    // ADR 0058: a bridge method is the interface and the channel map here PLUS the handler in apps/pos's
    // register.ts. The type system ties the first two (`satisfies Record<keyof DuljaPosBridge, string>`); this
    // ties the third, so a half-made change fails on Linux CI and not only in the Windows packaged spec. Read as
    // text: apps/desktop imports no POS source (spec:2389), and a test reading a file is not an import.
    const register = readFileSync(join(__dirname, "../../pos/src/main/register.ts"), "utf8");
    for (const [method, channel] of Object.entries(POS_CHANNELS)) {
      const kebab = method.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      expect(channel, method).toMatch(/^dulja:pos:[a-z-]+$/);
      expect(channel, method).toBe(`dulja:pos:${kebab}`);
      expect(register, method).toContain(`handle("${method}"`);
    }
    // And no handler for a method the bridge does not carry: the renderer could never reach it.
    const handled = [...register.matchAll(/\bhandle\("([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(handled.toSorted()).toEqual(Object.keys(POS_CHANNELS).toSorted());
  });
  it("actually exposes explicit POS calls with no encrypted-store or Node exports", async () => {
    expect(mocks.expose).toHaveBeenCalledTimes(1);
    const [namespace, bridge] = mocks.expose.mock.calls[0]! as unknown as [string, DuljaTillBridge];
    expect(namespace).toBe("dulja");
    expect(Object.keys(bridge)).toEqual(["app", "pos"]);
    expect(Object.keys(bridge.pos)).toEqual(Object.keys(POS_CHANNELS));
    const calls: [keyof typeof POS_CHANNELS, unknown[]][] = [
      ["enrol", ["CODE"]],
      ["login", [{ employeeNumber: "E", pin: "4821" }]],
      ["openShift", [{ openingFloat: "0.0000", currency: "MYR" }]],
      ["closeShift", [{ shiftId: "shift", countedCash: "0.0000" }]],
      ["search", [{ text: "rice" }]],
      ["priceCheck", [{ barcode: "9001" }]],
      ["sell", [{ lines: [] }]],
      ["tender", [{ tenders: [] }]],
      ["clock", ["clock_in"]],
      ["receipt", ["ref"]],
      ["print", ["ref"]],
      ["pull", []],
      ["drain", []],
      ["status", []],
    ];
    for (const [method, args] of calls) {
      mocks.invoke.mockClear();
      expect(await (bridge.pos[method] as (...args: unknown[]) => Promise<unknown>)(...args)).toBe(
        "answer",
      );
      expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(POS_CHANNELS[method], ...args);
    }
  });
  it("propagates a structured refusal whose code survives the contextBridge copy", async () => {
    const bridge = mocks.expose.mock.calls[0]![1] as DuljaTillBridge;
    mocks.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: "ERR_RBAC_FORBIDDEN", detail: "refused" },
    } as never);
    // Electron's contextBridge hands the page a copy of a rejected Error that keeps `message` and drops every
    // custom property (its docs, the `Error` row; electron/electron#25596). This is what the renderer catches.
    const rejected = await bridge.pos.sell({}).then(
      () => null,
      (error: unknown) => (error instanceof Error ? new Error(error.message) : error),
    );
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).not.toHaveProperty("code");
    expect((rejected as Error).message).toBe("ERR_RBAC_FORBIDDEN: refused");
  });
  it("loads POS by runtime build path with no source or package imports", () => {
    const main = readFileSync(join(__dirname, "../src/main-pos.ts"), "utf8");
    expect(main).toContain("dist-main/pos-main.cjs");
    expect(main).toContain("load(POS_MAIN)");
    expect(main).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:pos\/src|@dulja\/pos)/);
  });
});
