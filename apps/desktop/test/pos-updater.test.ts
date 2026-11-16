import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
interface BuildConfig {
  appId: string;
  productName: string;
  extraMetadata: { name: string; main: string };
  directories: { output: string };
  files: (string | { from: string; to: string; filter: string[] })[];
  extraResources: { from: string; to: string }[];
  asar: boolean;
  asarUnpack: string[];
  npmRebuild: boolean;
  forceCodeSigning: boolean;
  win: { target: { target: string; arch: string[] }[]; artifactName: string };
  nsis: Record<string, unknown>;
  publish: { provider: string; url: string }[];
}
describe("separate Windows POS packaging", () => {
  const pos = parse(read("electron-builder.pos.yml")) as BuildConfig;
  const office = parse(read("electron-builder.yml")) as BuildConfig;
  it("isolates product, package identity, executable, output and feed", () => {
    expect(pos.appId).toBe("my.dulja.pos");
    expect(pos.appId).not.toBe(office.appId);
    expect(pos.productName).toBe("Dulja POS");
    expect(pos.extraMetadata).toEqual({ name: "dulja-pos", main: "dist/main-pos.js" });
    expect(pos.directories.output).not.toBe(office.directories.output);
    expect(pos.publish).toEqual([{ provider: "generic", url: "${env.DULJA_POS_UPDATE_FEED}" }]);
    expect(pos.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(pos.forceCodeSigning).toBe(false);
  });
  it("installs per-user and names the artefact after the product (6B T10)", () => {
    // Per-user, because a shop PC's cashier account is not an administrator, and because updater.ts's
    // trust-root reasoning (app-update.yml under %LOCALAPPDATA%) is written for exactly this posture.
    expect(pos.nsis["perMachine"]).toBe(false);
    expect(pos.nsis["oneClick"]).toBe(false);
    // OPS-03: no space, or electron-updater's percent-encoded request is refused by the edge feed.
    expect(pos.win.artifactName).toBe("dulja-pos-${version}-windows-x64.${ext}");
    expect(office.win.artifactName).toBe("dulja-backoffice-${version}-windows-x64.${ext}");
  });
  it("hard-codes no package version in either builder config (spec:104, D22)", () => {
    for (const [name, text] of [
      ["pos", read("electron-builder.pos.yml")],
      ["backoffice", read("electron-builder.yml")],
    ] as const) {
      expect(text, name).not.toMatch(
        /^\s*(?:electron|electronVersion|electron-builder|better-sqlite3):\s*["']?\d/m,
      );
    }
    // The version the artefact carries is `${version}` from package.json, which is the lockfile's world.
    expect(read("electron-builder.pos.yml")).toContain("${version}");
  });
  it("places the build output inside asar so external native imports resolve, with SQLite unpacked", () => {
    expect(pos.asar).toBe(true);
    expect(pos.npmRebuild).toBe(false);
    expect(pos.files).toContainEqual({
      from: "../pos/dist-main",
      to: "pos-main",
      filter: ["*.cjs"],
    });
    expect(pos.extraResources).toEqual([
      { from: "../pos/dist", to: "renderer" },
      { from: "dist-config/pos-config.json", to: "pos-config.json" },
    ]);
    expect(pos.asarUnpack).toContain("**/node_modules/better-sqlite3/**");
    expect(read("src/main-pos.ts")).toContain('join(app.getAppPath(), "pos-main", "pos-main.cjs")');
  });
});
