import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** spec:2366: "core never imports HR". The repository's dependency lint enforces package boundaries; this test
 *  states the rule INSIDE the package, so a `packages/domain` change fails here first. */
describe("packages/domain/src never imports packages/domain/payroll (spec:2366)", () => {
  it("no file under src/ imports from a payroll path", async () => {
    const files = await walk(fileURLToPath(new URL("../../src", import.meta.url)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text, `${file} imports the payroll subtree`).not.toMatch(/from\s+["'][^"']*payroll/);
    }
  });
});
