import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LintRule, LintViolation } from "../types";

const SELF = "scripts/lint/rules/no-sql-concat.ts";

/** The reviewed `.unsafe()` call sites. `packages/importer/src/reader.ts` was here and never existed. */
export const UNSAFE_ALLOW: readonly string[] = [
  "packages/db/src/migrate.ts",
  "packages/db/src/jobs/enqueue.ts",
  "packages/db/test/harness.ts",
  "packages/db/test/roles.test.ts",
];
// `(?!=)`: `…/exchange-rates/lookup?from=MYR&to=MYR` is a URL, and in a URL a keyword glued to `=` is the name
// of a query parameter. SQL never writes one that way — `from`, `where` and the rest are always followed by
// whitespace, a paren or a comma — so refusing the `=` costs no detection and spares every route template an
// HTTP app builds. The preceding-character class stays as it was; only the character after the word is new.
const KEYWORDS = /(^|[^.\w])(select|insert|update|delete|where|from|order by)\b(?!=)/i;
const UNTAGGED_TEMPLATE = /(?:^|[^A-Za-z0-9_$)\]>])`([^`]*)`/g;
const CONCAT =
  /(?:["'][^"']*\b(?:select|insert|update|delete|from|where|order by)\b[^"']*["']\s*\+|\+\s*["'][^"']*\b(?:select|insert|update|delete|from|where|order by)\b[^"']*["'])/i;

/**
 * A whole-line comment: `//`, a `*` continuation, or a `/*` opener. Prose never reaches a database. Exported
 * so `tests/regression/sah-036.test.ts` — which pins WHERE `.unsafe(` may live — skips exactly the lines
 * this rule skips; two hand-written regexes had already drifted once (Phase 3 review pass).
 */
export const isCommentLine = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Resolved from this module, not `process.cwd()`, so a caller in another directory gets the same answer. */
const fromRoot = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/** The line of this file that names `path`, so the violation is navigable. */
function allowLine(path: string): number {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(`"${path}"`));
  return index < 0 ? 1 : index + 1;
}

/**
 * An exemption for a file that does not exist is an exemption nobody reviewed: it is granted in advance, and the
 * day the path is finally written the new file is born exempt from the SQL-injection rule with no second look.
 * So the list is checked both ways, the way `ci-test-filters` checks its own exclusions against the workspaces.
 */
export function staleAllowEntries(entries: readonly string[]): LintViolation[] {
  return entries
    .filter((path) => !existsSync(fromRoot(path)))
    .map((path) => ({
      file: SELF,
      line: allowLine(path),
      rule: "no-sql-concat",
      detail: `'${path}' is on UNSAFE_ALLOW but does not exist — a pre-granted exemption; remove the entry, or fix the path if the file moved`,
    }));
}

export const rule: LintRule = {
  name: "no-sql-concat",
  run(files) {
    const violations: LintViolation[] = staleAllowEntries(UNSAFE_ALLOW);
    for (const file of files) {
      if (!/^(apps|packages)\//.test(file.path)) continue;
      file.lines.forEach((line, index) => {
        // A comment is prose, and prose never reaches a database. This repository documents *why* densely, so
        // the comment above a tenant-isolation fix quotes the predicate the fix replaced — scanning it reads
        // that quotation as constructed SQL and taxes the explanation. Whole-line comments only: a trailing
        // `// …` after real code leaves the code before it on the line, and that code is still scanned.
        if (isCommentLine(line)) return;
        const unsafe = /\.unsafe\(\s*([^)]*)\)/.exec(line);
        if (unsafe && !UNSAFE_ALLOW.includes(file.path) && !/^\s*["'`]/.test(unsafe[1] ?? ""))
          violations.push({
            file: file.path,
            line: index + 1,
            rule: this.name,
            detail: ".unsafe() with a non-literal argument outside UNSAFE_ALLOW",
          });

        let built = CONCAT.test(line);
        UNTAGGED_TEMPLATE.lastIndex = 0;
        for (
          let match = UNTAGGED_TEMPLATE.exec(line);
          match !== null && !built;
          match = UNTAGGED_TEMPLATE.exec(line)
        ) {
          const body = match[1] ?? "";
          built = body.includes("${") && KEYWORDS.test(body);
        }
        if (built)
          violations.push({
            file: file.path,
            line: index + 1,
            rule: this.name,
            detail: "SQL assembled from a string; use a `tx` tagged template with bound values",
          });
      });
    }
    return violations;
  },
};
