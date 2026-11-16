import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { SourceFile } from "./types";
export function sourceFiles(roots = ["apps", "packages", "scripts"]): SourceFile[] {
  const out: SourceFile[] = [];
  const visit = (path: string) => {
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (["node_modules", "dist", "coverage", ".turbo"].includes(item.name)) continue;
      const full = join(path, item.name);
      if (item.isDirectory()) visit(full);
      else if (/\.(ts|tsx|sql)$/.test(item.name)) {
        const text = readFileSync(full, "utf8");
        out.push({
          path: relative(process.cwd(), full).replaceAll("\\", "/"),
          text,
          lines: text.split("\n"),
        });
      }
    }
  };
  for (const root of roots) visit(root);
  return out;
}
