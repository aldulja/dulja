import type { LintRule, LintViolation, SourceFile } from "../types";

const CATALOGUE_FILE = "packages/contracts/permissions.ts";
const ROLE_SEED_FILE = "packages/db/seed/roles.ts";
const REFERENCE_SCOPE = /^(apps\/(api|worker|pos)\/|packages\/(sync\/|db\/src\/))/;

function catalogueCodes(file: SourceFile): string[] {
  return [...file.text.matchAll(/\bcode\s*:\s*["']([^"']+)["']/g)].map((match) => match[1]!);
}
function lineOf(file: SourceFile, offset: number): number {
  return file.text.slice(0, offset).split(/\r?\n/).length;
}

export const rule: LintRule = {
  name: "permission-catalogue",
  run(files): LintViolation[] {
    const catalogueFile = files.find((file) => file.path === CATALOGUE_FILE);
    if (!catalogueFile) return [];
    const catalogue = new Set(catalogueCodes(catalogueFile));
    const referenced = new Set<string>();
    const violations: LintViolation[] = [];

    for (const file of files) {
      if (file.path === CATALOGUE_FILE || file.path === ROLE_SEED_FILE) continue;
      if (!REFERENCE_SCOPE.test(file.path)) continue;
      for (const code of catalogue) if (file.text.includes(code)) referenced.add(code);
      const named =
        /(?:requirePermission|principalHas)\(\s*["']([^"']+)["']|PERMISSION\[\s*["']([^"']+)["']\s*\]/g;
      for (const match of file.text.matchAll(named)) {
        const code = match[1] ?? match[2]!;
        if (!catalogue.has(code))
          violations.push({
            file: file.path,
            line: lineOf(file, match.index),
            rule: "permission-catalogue",
            detail: `'${code}' is not in the catalogue`,
          });
      }
    }
    const orphans = [...catalogue].filter((code) => !referenced.has(code)).toSorted();
    if (orphans.length > 0)
      violations.push({
        file: CATALOGUE_FILE,
        line: 1,
        rule: "permission-catalogue",
        detail: `${orphans.join(", ")} have no route or job handler`,
      });
    return violations;
  },
};
