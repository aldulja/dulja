import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "../..");

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, relative), "utf8")) as Record<string, unknown>;

/**
 * `tsconfig.base.json` sets `"types": ["node"]`, which every workspace inherits. Unlike an ordinary
 * import, a `types` entry naming a bare `node` is resolved as a *type reference directive*: TypeScript
 * looks only in `node_modules/@types` directories, walking up from the tsconfig — and it does not stop
 * at the repository root. It will happily climb into the user's home directory and beyond.
 *
 * That is not hypothetical. Before this file existed, ten of the twelve workspaces declared no
 * `@types/node` of their own, and on the machine this was found on `--traceResolution` showed
 * `packages/contracts` resolving `node` to `C:/Users/<user>/node_modules/@types/node/index.d.ts` — a
 * stray install in the developer's home folder, sitting beside unrelated packages, outside the
 * repository entirely. `turbo run typecheck` was 12/12 green locally and had been for the whole of
 * Phase 0. A Linux CI runner has no such directory, so CI failed with
 * `TS2688: Cannot find type definition file for 'node'` — and because the crutch was invisible and
 * outside the tree, the failure never reproduced on the machine that had to fix it.
 *
 * The fix is the root `@types/node` devDependency, which lands in `<repo>/node_modules/@types` and is
 * therefore found before the walk can leave the repository. Nothing imports it, so it reads as unused
 * to anyone tidying dependencies; this test is what makes it load-bearing in a way a reader can see.
 */
describe("type resolution never escapes the repository", () => {
  it("tsconfig.base.json still imposes the `node` type reference every workspace relies on", () => {
    const base = readJson("tsconfig.base.json");
    const options = base["compilerOptions"] as { types?: readonly string[] };
    // If this ever stops being true, the devDependency below is no longer load-bearing and this whole
    // file should be deleted rather than quietly weakened — hence asserting the premise, not just the
    // conclusion.
    expect(options.types).toContain("node");
  });

  it("the root declares @types/node, so the `@types` walk resolves inside the tree", () => {
    const root = readJson("package.json");
    const devDependencies = root["devDependencies"] as Record<string, string>;
    expect(
      devDependencies["@types/node"],
      "Removing this makes every workspace that does not declare @types/node itself resolve `node` " +
        "from outside the repository — green locally, TS2688 in CI. See this file's docblock.",
    ).toBeDefined();
  });
});
