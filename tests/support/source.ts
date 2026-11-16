import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceFile } from "../../scripts/lint/types";

/** The repository root, two levels up from tests/support/. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SKIP = new Set(["node_modules", "dist", ".turbo", ".drizzle", ".git", "openapi.json"]);

/**
 * Re-walks the tree `scripts/lint/run.ts` scans (its `ROOTS`), producing the `SourceFile` shape Task 12 froze.
 * `run.ts` is a CLI — it walks, prints and calls `process.exit` — so it exports no walker and the walk is repeated
 * here. `node:fs`, never `Bun.Glob`: the `tests` workspace runs under Node 24 via Vitest (D5).
 */
export function sourceFiles(roots: string[] = ["apps", "packages", "scripts"]): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    if (statSync(dir).isFile()) {
      if (/\.tsx?$/.test(dir)) {
        const text = readFileSync(dir, "utf8");
        out.push({
          path: relative(REPO_ROOT, dir).replaceAll("\\", "/"),
          text,
          lines: text.split("\n"),
        });
      }
      return;
    }
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      const text = readFileSync(full, "utf8");
      out.push({
        path: relative(REPO_ROOT, full).replaceAll("\\", "/"),
        text,
        lines: text.split("\n"),
      });
    }
  };
  for (const r of roots) walk(join(REPO_ROOT, r));
  return out;
}
