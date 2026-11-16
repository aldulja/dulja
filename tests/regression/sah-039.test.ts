import { describe, expect, it } from "vitest";
import { ROUTES } from "@dulja/api";
import { repoFile } from "../support/regression"; // cwd is tests/, so every repo path is resolved

/**
 * SAH-039 · H · `procInitDatabase` creates an administrator, unauthenticated, with no already-initialised guard.
 * The fix is structural, so the test is structural: bootstrap is a CLI, it needs the migrator credential, and no
 * route in the system can reach it (spec:2188).
 */
describe("SAH-039 procInitDatabase creates an admin, unauthenticated, unguarded — 0C", () => {
  it("no registered route is an initialisation endpoint", () => {
    // Whole path-segment words, split on "/" and "-": a bare substring match would flag
    // `custom-field-definitions` ("defINITions") while missing nothing a real bootstrap route would be called.
    const bootstrapWord = /(^|[/-])(seed|init|initiali[sz]e|bootstrap|setup|install)([/-]|$)/i;
    const offenders = ROUTES.filter((r) => bootstrapWord.test(r.path));
    expect(offenders.map((r) => r.path)).toEqual([]);
  });

  it("the seed lives in the CLI, and the CLI demands the migrator credential", () => {
    const cli = repoFile("packages/db/src/cli.ts");
    expect(cli).toContain('cmd === "seed"');
    expect(cli).toContain("DATABASE_URL_MIGRATOR");
    // app_rw is the API's role; it holds no privilege that could bootstrap a tenant.
    expect(cli).not.toMatch(/process\.env\["DATABASE_URL"\]/);
  });

  it("no application source outside the CLI and the seed modules imports the seed", () => {
    for (const file of [
      "apps/api/src/app.ts",
      "apps/api/src/routes/index.ts",
      "apps/worker/src/index.ts",
    ]) {
      expect(repoFile(file), file).not.toMatch(/from ["'].*seed/);
    }
  });

  it("@dulja/db's main entry does not re-export the seed — the service-role client is not on the serving path", () => {
    // The grep above is textual, so an `export * from "./seed"` in the package barrel would walk straight past it:
    // every `import { withTenant } from "@dulja/db"` in apps/api would then transitively load the Supabase
    // service-role admin client. The test tier reaches the seed through the "./seed" subpath export instead.
    const barrel = repoFile("packages/db/src/index.ts");
    expect(barrel).not.toMatch(/from ["']\.\/seed/);
  });

  it("running it twice is the documented contract, not an accident (spec:2317)", () => {
    expect(repoFile("docs/adr/0012-seed-pack-format.md")).toMatch(/idempotent/i);
  });

  it("the seed is reachable only through the ./seed subpath, and no production file uses it", () => {
    const manifest = JSON.parse(repoFile("packages/db/package.json")) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports["./seed"]).toBe("./src/seed/index.ts");
    for (const file of [
      "apps/api/src/app.ts",
      "apps/api/src/index.ts",
      "apps/worker/src/index.ts",
    ]) {
      expect(repoFile(file), file).not.toContain("@dulja/db/seed");
    }
  });
});
