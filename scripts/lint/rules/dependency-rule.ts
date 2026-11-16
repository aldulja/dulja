import { createScanner, SyntaxKind } from "typescript/unstable/ast";
import type { LintRule, LintViolation, SourceFile } from "../types";

const TIER: Record<string, readonly string[]> = {
  "packages/domain": [],
  "packages/i18n": [],
  "packages/db": ["@dulja/domain"],
  "packages/contracts": ["@dulja/domain"],
  "packages/sync": ["@dulja/domain", "@dulja/contracts"],
  "packages/ui": ["@dulja/i18n"],
  "packages/importer": ["@dulja/domain", "@dulja/db", "@dulja/contracts"],
  "apps/api": ["@dulja/domain", "@dulja/db", "@dulja/contracts", "@dulja/sync"],
  // 7A T10: the report renderers format through 0E's @dulja/i18n (spec:2061, spec:2253), never a second policy.
  // 9B T9: the admin.import.run handler runs @dulja/importer's runLoad (round 20 C10 gives the worker LEGACY_ODBC_DSN).
  "apps/worker": [
    "@dulja/domain",
    "@dulja/db",
    "@dulja/contracts",
    "@dulja/sync",
    "@dulja/i18n",
    "@dulja/importer",
  ],
  "apps/edge": ["@dulja/contracts"],
  "apps/pos": ["@dulja/domain", "@dulja/contracts", "@dulja/sync", "@dulja/ui", "@dulja/i18n"],
  "apps/backoffice": ["@dulja/domain", "@dulja/contracts", "@dulja/ui", "@dulja/i18n"],
  "apps/desktop": [],
};
const ALLOW = new Set(["packages/db/test/permission-catalogue.test.ts|@dulja/contracts"]);
const ESCAPE_ALLOW: readonly { readonly from: RegExp; readonly to: string }[] = [
  { from: /^apps\/api\/test\//, to: "tests/support/" },
  { from: /^apps\/api\/test\//, to: "tests/invariants/support/" },
  { from: /^apps\/worker\/test\//, to: "tests/support/" },
  { from: /^apps\/worker\/test\//, to: "tests/invariants/support/" },
  // Test tier to test tier: packages/db/test/** may import tests/invariants/support/** — both are test code,
  // and slice 3B's DB-tier costing suites must post through the same real postInventoryDocument the invariant
  // and regression suites use rather than a second copy of it (contracts §4.17.1's closing paragraph, widened
  // by 3B's amendment A21(c); §4.17 assigns 3B no fixtures.ts helper, hazard 9). PRODUCTION code under
  // packages/**/src/** may still import nothing from tests/.
  { from: /^packages\/db\/test\//, to: "tests/invariants/support/" },
  // 8C amendment B15 (round 18): packages/db/test/** may import the test tier's tests/support/** too — REPO_ROOT and
  // sourceFiles (0B) for the closed-write-list scans; a fixture that posts through the real postDocument cannot
  // live in fixtures.ts, and packages/db may not import an app (contracts §3.1, §4.17.1).
  { from: /^packages\/db\/test\//, to: "tests/support/" },
];

/** Only real TypeScript is scanned. `sourceFiles()` also hands this rule `.sql`, where `from 'x'` is a
 *  query clause, not an import — the matcher this replaced was line-anchored on `import`/`export` and so
 *  never looked at SQL either. */
const SCANNED = /\.tsx?$/;
interface Specifier {
  readonly specifier: string;
  /** 1-based, and the **specifier's own** line: a wrapped import reports `} from "…"`, not `import {`. */
  readonly line: number;
}

/**
 * A string literal is a module specifier when — and only when — one of four token shapes precedes it:
 * `from` (every `import … from` / `export … from`, single-line or wrapped), `import` directly (a bare
 * side-effect `import "…"`), `import (` (dynamic), or `require (`. Everything else is a string that
 * merely happens to contain a package name.
 *
 * That test is what makes comment and string handling free rather than hand-written: the scanner is
 * created with `skipTrivia`, so a specifier written inside a line comment, a block comment or a JSDoc
 * block never produces a token at all, and a literal in `const s = "@dulja/db"` or
 * `{ from: "@dulja/db" }` has `=` or `:` in front of it rather than any of the four shapes.
 */
function isSpecifierPosition(previous?: SyntaxKind, beforeThat?: SyntaxKind): boolean {
  if (previous === SyntaxKind.FromKeyword || previous === SyntaxKind.ImportKeyword) return true;
  if (previous !== SyntaxKind.OpenParenToken) return false;
  // `require` is one of TypeScript's contextual keywords (it has its own `SyntaxKind` for
  // `import x = require("…")`), so the scanner reports it as `RequireKeyword` in *every* position,
  // including a plain CommonJS call — never as an `Identifier`. Matching on the identifier text
  // instead silently covered nothing.
  return beforeThat === SyntaxKind.ImportKeyword || beforeThat === SyntaxKind.RequireKeyword;
}

/**
 * Every module specifier in the file, with the line its literal sits on.
 *
 * This is a whole-file token scan rather than a per-line regex because the per-line regex could not
 * see a shape oxfmt writes routinely: a named import too long for the 100-column print width wraps,
 * ending `} from "@dulja/x";` on a line of its own, anchored to nothing the old pattern matched.
 * Every instance of it in the tree happened to be legal when this was found, so the tree was compliant
 * while the enforcement was not. `await import(…)` and `require(…)` were invisible for the same reason.
 *
 * `templates` is not optional bookkeeping. After a `${…}` substitution's closing `}`, the scanner sits
 * on literal template text; without `reScanTemplateToken` the next backtick reads as *opening* a new,
 * unterminated template that swallows every token to end of file — which would silently hide any
 * `import(…)`/`require(…)` written after a template literal, i.e. re-create this very defect in a
 * subtler form. One entry per open template, holding its substitution's own `{` nesting depth so an
 * object literal inside the substitution is not mistaken for the substitution's end.
 */
function specifiersOf(file: SourceFile): Specifier[] {
  if (!SCANNED.test(file.path)) return [];
  const scanner = createScanner(true, undefined, file.text);
  const found: Specifier[] = [];
  const templates: number[] = [];
  let previous: SyntaxKind | undefined;
  let beforeThat: SyntaxKind | undefined;
  for (
    let kind: SyntaxKind = scanner.scan();
    kind !== SyntaxKind.EndOfFile;
    kind = scanner.scan()
  ) {
    if (kind === SyntaxKind.TemplateHead) templates.push(0);
    else if (templates.length > 0 && kind === SyntaxKind.OpenBraceToken)
      templates[templates.length - 1] = templates[templates.length - 1]! + 1;
    else if (templates.length > 0 && kind === SyntaxKind.CloseBraceToken) {
      const depth = templates[templates.length - 1]!;
      if (depth > 0) templates[templates.length - 1] = depth - 1;
      else {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) templates.pop();
      }
    } else if (kind === SyntaxKind.StringLiteral && isSpecifierPosition(previous, beforeThat))
      found.push({
        specifier: scanner.getTokenValue(),
        line: file.text.slice(0, scanner.getTokenStart()).split("\n").length,
      });
    beforeThat = previous;
    previous = kind;
  }
  return found;
}

function resolveRelative(fromPath: string, specifier: string): string {
  const parts = fromPath.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export const rule: LintRule = {
  name: "dependency-rule",
  run(files) {
    const violations: LintViolation[] = [];
    for (const file of files) {
      const owner = Object.keys(TIER).find((candidate) => file.path.startsWith(`${candidate}/`));
      if (!owner) continue;
      for (const { specifier, line } of specifiersOf(file)) {
        const packageRoot = specifier.split("/").slice(0, 2).join("/");
        if (
          specifier.startsWith("@dulja/") &&
          !TIER[owner]!.includes(packageRoot) &&
          !ALLOW.has(`${file.path}|${packageRoot}`) &&
          !(owner === "apps/pos" && specifier === "@dulja/db/staff/pin")
        )
          violations.push({
            file: file.path,
            line,
            rule: this.name,
            detail: `${owner} may not import ${packageRoot}`,
          });
        if (/^\.\.?\//.test(specifier)) {
          const target = resolveRelative(file.path, specifier);
          const allowed = ESCAPE_ALLOW.some(
            (entry) => entry.from.test(file.path) && target.startsWith(entry.to),
          );
          if (!target.startsWith(`${owner}/`) && !allowed)
            violations.push({
              file: file.path,
              line,
              rule: this.name,
              detail: `${owner} reaches outside its own workspace by relative path`,
            });
        }
        if (file.path.startsWith("packages/domain/src/") && /(^|\/)payroll\//.test(specifier))
          violations.push({
            file: file.path,
            line,
            rule: this.name,
            detail: "packages/domain/src may not import packages/domain/payroll",
          });
      }
    }
    return violations;
  },
};
