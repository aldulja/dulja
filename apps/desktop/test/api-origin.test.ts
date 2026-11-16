import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(join(__dirname, "..", path), "utf8");

/**
 * OPS-05 / PRD-02 (ADR 0093). A packaged till used to read its API address from the logged-in user's
 * environment and fall back to plain-http loopback, so an installed `pos.exe` enrolled against nothing,
 * and any user-level process could `setx` it onto another server.
 */
describe("the till's API origin", () => {
  it("main-pos.ts reads DULJA_API_BASE_URL only through resolveApiOrigin, with the real packaged flag", () => {
    const main = read("src/main-pos.ts");
    expect(main).not.toContain('"http://127.0.0.1:3000"');
    expect(main).toMatch(/resolveApiOrigin\(\s*app\.isPackaged\s*,/);
    const reads = main.match(
      /process\.env(?:\[\s*["']DULJA_API_BASE_URL["']\s*\]|\.DULJA_API_BASE_URL\b)/g,
    );
    expect(reads ?? []).toHaveLength(1);
  });

  it("a packaged till uses the origin baked at build time and ignores the environment", async () => {
    const { resolveApiOrigin } = await import("../src/api-origin");
    expect(
      resolveApiOrigin(true, "https://attacker.example", {
        apiBaseUrl: "https://api.dulja.example",
      }),
    ).toBe("https://api.dulja.example");
  });

  it("a packaged till refuses a missing, malformed or non-https baked origin", async () => {
    const { resolveApiOrigin } = await import("../src/api-origin");
    expect(() => resolveApiOrigin(true, undefined, null)).toThrow(/no API origin/);
    expect(() => resolveApiOrigin(true, undefined, { apiBaseUrl: "" })).toThrow(/no API origin/);
    expect(() => resolveApiOrigin(true, undefined, { apiBaseUrl: "not a url" })).toThrow(/https/);
    expect(() =>
      resolveApiOrigin(true, undefined, { apiBaseUrl: "http://127.0.0.1:3000" }),
    ).toThrow(/https/);
    expect(() =>
      resolveApiOrigin(true, undefined, { apiBaseUrl: "http://api.dulja.example" }),
    ).toThrow(/https/);
  });

  it("a development run honours the variable, then the baked file, then loopback", async () => {
    const { DEV_API_BASE_URL, resolveApiOrigin } = await import("../src/api-origin");
    expect(resolveApiOrigin(false, "http://127.0.0.1:3100", null)).toBe("http://127.0.0.1:3100");
    expect(resolveApiOrigin(false, "", { apiBaseUrl: "https://api.invalid" })).toBe(
      "https://api.invalid",
    );
    expect(resolveApiOrigin(false, undefined, null)).toBe(DEV_API_BASE_URL);
  });

  it("the packaged config travels as a resource beside the renderer, written at packaging time", () => {
    const pos = read("electron-builder.pos.yml");
    expect(pos).toMatch(/from:\s*dist-config\/pos-config\.json\s*\n\s*to:\s*pos-config\.json/);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    for (const script of ["dist:pos", "dist:pos:dir"])
      expect(pkg.scripts[script]).toMatch(/^bun scripts\/write-pos-config\.ts && electron-builder/);
  });
});
