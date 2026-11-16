import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      steps: Step[];
      needs?: string | string[];
      if?: string;
      "runs-on"?: string;
      permissions?: Record<string, string>;
    }
  >;
}
const workflow = (name: string): Workflow =>
  parse(readFileSync(join(__dirname, "../../../.github/workflows", name), "utf8")) as Workflow;
const indexOf = (steps: Step[], match: (s: Step) => boolean): number => steps.findIndex(match);

describe("build scripts leave both sandboxed preloads bundled", () => {
  // `tsc -p tsconfig.build.json` emits an unbundled `dist/preload.js` that `require`s sibling modules, which a
  // sandboxed preload cannot do. `build:pos` re-ran tsc after `build` and left the back office's preload
  // unbundled: every development-tree launch after it lost its window (found by this PR's first Windows run).
  const scripts = (
    JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  it("build bundles both preloads after tsc", () => {
    const build = scripts["build"]!;
    const tsc = build.indexOf("tsc -p tsconfig.build.json");
    expect(tsc).toBeGreaterThanOrEqual(0);
    for (const preload of ["src/preload.ts", "src/preload-pos.ts"])
      expect(build.indexOf(`bun build ${preload}`), preload).toBeGreaterThan(tsc);
  });
  it("build:pos goes through build rather than running tsc on its own", () => {
    expect(scripts["build:pos"]).not.toContain("tsc ");
    expect(scripts["build:pos"]).toMatch(/&& bun run build$/);
  });
});

describe("ci.yml's desktop job (OPS-04, PRD-32)", () => {
  const steps = workflow("ci.yml").jobs["desktop"]!.steps;

  it("packages both products as unpacked trees, never a full installer, on every PR", () => {
    const runs = steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toMatch(/apps\/desktop dist:dir/);
    expect(runs).toMatch(/apps\/desktop dist:pos:dir/);
    expect(runs).not.toMatch(/apps\/desktop dist:pos(?!:dir)/);
    expect(runs).not.toMatch(/apps\/desktop dist(?![:\w])/);
  });

  it("keeps any artefact it uploads for one day only", () => {
    for (const step of steps.filter((s) => s.uses?.startsWith("actions/upload-artifact"))) {
      expect(step.with?.["retention-days"], step.name).toBe(1);
    }
  });

  it("bakes an https placeholder API origin into the till and smoke-tests both packages", () => {
    const pack = indexOf(steps, (s) => (s.run ?? "").includes("dist:pos:dir"));
    expect(steps[pack]!.env?.["DULJA_API_BASE_URL"]).toMatch(/^https:\/\//);
    const smoke = indexOf(
      steps,
      (s) =>
        (s.run ?? "").includes("test:electron") && s.env?.["DULJA_REQUIRE_POS_PACKAGE"] === "1",
    );
    expect(smoke).toBeGreaterThan(pack);
    expect(steps[smoke]!.env?.["DULJA_REQUIRE_PACKAGE"]).toBe("1");
  });

  it("gives the unpacked trees a non-loopback app-update.yml, so the packaged feed checks run on PRs", () => {
    const write = indexOf(steps, (s) => (s.run ?? "").includes("app-update.yml"));
    const smoke = indexOf(steps, (s) => s.env?.["DULJA_REQUIRE_PACKAGE"] === "1");
    expect(write).toBeGreaterThan(0);
    expect(write).toBeLessThan(smoke);
    expect(steps[write]!.run).toContain("https://updates.invalid/backoffice/");
    expect(steps[write]!.run).toContain("https://updates.invalid/pos/");
  });
});

describe("release.yml (OPS-06, OPS-09, Phase 4 preview)", () => {
  const release = workflow("release.yml");
  const steps = release.jobs["windows-installer"]!.steps;
  const text = readFileSync(join(__dirname, "../../../.github/workflows/release.yml"), "utf8");

  it("offers a preview dispatch that builds with clearly marked placeholders", () => {
    const dispatch = release.on["workflow_dispatch"] as { inputs?: Record<string, unknown> };
    expect(dispatch.inputs?.["preview"]).toBeDefined();
    expect(text).toContain("https://api.invalid");
  });

  it("guards the till's API origin and requires it to be https on a tag build", () => {
    const guard = steps.find((s) => s.name?.startsWith("Fail fast"))!;
    expect(guard.env?.["DULJA_API_BASE_URL"]).toBeDefined();
    expect(guard.run).toMatch(/DULJA_API_BASE_URL/);
    expect(guard.run).toMatch(/https:\/\//);
  });

  it("bakes the API origin into the POS package", () => {
    const pack = steps.find((s) => (s.run ?? "").includes("apps/desktop dist:pos"))!;
    expect(pack.env?.["DULJA_API_BASE_URL"]).toBeDefined();
  });

  it("derives the app version from the tag and stamps it before either installer is packaged", () => {
    const stamp = indexOf(
      steps,
      (s) => (s.run ?? "").includes("npm pkg set") && (s.run ?? "").includes("APP_VERSION"),
    );
    expect(stamp).toBeGreaterThan(0);
    for (const script of ["apps/desktop dist\n", "apps/desktop dist:pos\n"]) {
      const pack = indexOf(steps, (s) => `${s.run ?? ""}\n`.includes(script));
      expect(pack, script).toBeGreaterThan(stamp);
    }
    expect(text).toMatch(/GITHUB_REF_NAME -replace '\^v'/);
  });

  it("installs both NSIS installers silently and smoke-tests the installed apps", () => {
    const runs = steps.map((s) => s.run ?? "").join("\n");
    expect(runs).toMatch(/dulja-backoffice-\*-windows-x64\.exe/);
    expect(runs).toMatch(/dulja-pos-\*-windows-x64\.exe/);
    expect(runs).toMatch(/\/S\b/);
    const smoke = steps.find((s) => s.env?.["DULJA_BACKOFFICE_EXE"] !== undefined);
    expect(smoke?.env?.["DULJA_POS_EXE"]).toBeDefined();
  });

  it("uploads both installers with a short retention", () => {
    const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(uploads.map((s) => s.with?.["name"])).toEqual(
      expect.arrayContaining(["backoffice-installer", "pos-installer"]),
    );
    for (const step of uploads) {
      expect(
        Number(step.with?.["retention-days"]),
        String(step.with?.["name"]),
      ).toBeLessThanOrEqual(7);
      expect(String(step.with?.["path"])).toMatch(/dulja-(backoffice|pos)-\*-windows-x64\.exe/);
      // `latest.yml` for a release, `preview.yml` for a preview build (the version's channel).
      // Named, never `*.yml`: that would also ship `builder-debug.yml`, which names build-machine paths.
      expect(String(step.with?.["path"])).toMatch(/latest\.yml/);
      expect(String(step.with?.["path"])).toMatch(/preview\.yml/);
      expect(String(step.with?.["path"])).not.toMatch(/\*\.yml/);
    }
  });
});

describe("release.yml's GitHub Release (both installers on the repository's Releases page)", () => {
  const release = workflow("release.yml");
  const job = release.jobs["github-release"]!;
  const runs = job.steps.map((s) => s.run ?? "").join("\n");

  it("runs only on a version tag, after the installers were installed and smoke-tested", () => {
    expect(job.needs).toBe("windows-installer");
    expect(job.if).toMatch(/startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  });

  it("is the only job allowed to write, and the signing job stays read-only", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "write" });
    expect(release.jobs["windows-installer"]!.permissions).toBeUndefined();
    // No secret reaches this job: it never checks the code out or runs it, only downloads and publishes.
    expect(job.steps.some((s) => s.uses?.startsWith("actions/checkout"))).toBe(false);
  });

  it("downloads both installers and attaches them, with checksums, to a release named for the tag", () => {
    const downloads = job.steps.filter((s) => s.uses?.startsWith("actions/download-artifact"));
    expect(downloads.map((s) => s.with?.["name"])).toEqual(
      expect.arrayContaining(["backoffice-installer", "pos-installer"]),
    );
    expect(runs).toMatch(/gh release create "\$GITHUB_REF_NAME"/);
    expect(runs).toMatch(/dulja-backoffice-\*-windows-x64\.exe/);
    expect(runs).toMatch(/dulja-pos-\*-windows-x64\.exe/);
    expect(runs).toMatch(/sha256sum/);
    // A `v1.2.3-rc.1` tag is a prerelease, never shown as the latest download.
    expect(runs).toMatch(/--prerelease/);
  });
});
