import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LintRule, LintViolation } from "../types";

const CI_WORKFLOW = ".github/workflows/ci.yml";
const SELF = "scripts/lint/rules/ci-test-filters.ts";

/**
 * Repository-relative paths are reported as-is but read through here. Unlike every other rule, this one opens
 * files itself rather than reading the `SourceFile[]` it is handed — `scripts/lint/source.ts` collects only
 * `.ts`/`.tsx`/`.sql` under `apps`, `packages` and `scripts`, and neither a workflow nor a manifest is any of
 * those. Resolving from `import.meta.url` rather than `process.cwd()` means a caller in another directory gets
 * a correct answer instead of a spurious violation.
 */
const fromRoot = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url));

/**
 * Every workspace with a `test` script that the `checks` job's `--filter` list deliberately omits, and why.
 * Adding a name here is the conscious act this rule exists to force; the rule also fails if a name here is
 * not a workspace with a `test` script, so the list goes red on a rename exactly as the filter list does.
 */
const EXCLUDED: ReadonlyMap<string, string> = new Map([
  [
    "@dulja/db",
    "Testcontainers + the Linux postgres image, which windows-latest's Docker cannot run; the ubuntu `database` job runs it",
  ],
  [
    "@dulja/importer",
    "9B's loader suites (test/load/run.test.ts onward) need Testcontainers + the Linux postgres image, which windows-latest's Docker cannot run; the ubuntu `database` job runs the whole workspace",
  ],
  [
    "@dulja/api",
    "Testcontainers + the Linux postgres image, which windows-latest's Docker cannot run; the ubuntu `database` job runs it",
  ],
  [
    "@dulja/worker",
    "Testcontainers + the Linux postgres image, which windows-latest's Docker cannot run; the ubuntu `database` job runs it",
  ],
  [
    "@dulja/tests",
    "Testcontainers + the Linux postgres image, which windows-latest's Docker cannot run; the ubuntu `database` job runs it",
  ],
  [
    "@dulja/desktop",
    "the `desktop` job runs `bun run --cwd apps/desktop test` directly; running it twice would only slow the PR",
  ],
]);

interface Workspace {
  name: string;
  hasTest: boolean;
}

/** The `workspaces` globs of the root manifest, expanded — never a second hardcoded list of packages. */
function workspaces(): Workspace[] {
  const manifest = JSON.parse(readFileSync(fromRoot("package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const directories: string[] = [];
  for (const pattern of manifest.workspaces ?? []) {
    if (!pattern.endsWith("/*")) {
      directories.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    if (!existsSync(fromRoot(parent))) continue;
    for (const entry of readdirSync(fromRoot(parent), { withFileTypes: true }))
      if (entry.isDirectory()) directories.push(`${parent}/${entry.name}`);
  }
  const found: Workspace[] = [];
  for (const directory of directories) {
    const path = `${directory}/package.json`;
    if (!existsSync(fromRoot(path))) continue;
    const parsed = JSON.parse(readFileSync(fromRoot(path), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (parsed.name) found.push({ name: parsed.name, hasTest: Boolean(parsed.scripts?.["test"]) });
  }
  return found;
}

/** The `--filter=` arguments of the `turbo run test` step, and the line the step starts on. */
function turboFilters(text: string): { names: Set<string>; line: number } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("bun run turbo run test"));
  if (start < 0) return { names: new Set(), line: 1 };
  const names = new Set<string>();
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index > start && !/^\s*--filter=/.test(line)) break;
    for (const match of line.matchAll(/--filter=(\S+)/g)) names.add(match[1]!);
  }
  return { names, line: start + 1 };
}

/** The line of this file that declares `name` in EXCLUDED, so the violation is navigable. */
function exclusionLine(name: string): number {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const index = text.split(/\r?\n/).findIndex((line) => line.includes(`"${name}"`));
  return index < 0 ? 1 : index + 1;
}

/**
 * The `checks` job names the workspaces it tests, and an inclusion list cannot notice an omission: turbo
 * plans no task for a workspace nobody named and exits 0, so a newly added workspace would be silently
 * untested with CI still green. (Only a filter naming a workspace that does *not* exist is an error —
 * measured on turbo 2.10.12 in this tree: `--filter=@dulja/nonexistent` → "No package found with name".)
 * This rule supplies the missing half: every workspace with a `test` script is in the filter list or on
 * EXCLUDED above, and every EXCLUDED name is still a workspace with a `test` script.
 */
export const rule: LintRule = {
  name: "ci-test-filters",
  run(): LintViolation[] {
    const violations: LintViolation[] = [];
    if (!existsSync(fromRoot(CI_WORKFLOW)))
      return [
        {
          file: CI_WORKFLOW,
          line: 1,
          rule: "ci-test-filters",
          detail: "the workflow this rule checks does not exist",
        },
      ];
    const { names: filters, line } = turboFilters(readFileSync(fromRoot(CI_WORKFLOW), "utf8"));
    const all = workspaces();
    const testable = new Map(all.filter((one) => one.hasTest).map((one) => [one.name, one]));

    for (const name of [...testable.keys()].toSorted()) {
      if (filters.has(name) && EXCLUDED.has(name))
        violations.push({
          file: CI_WORKFLOW,
          line,
          rule: "ci-test-filters",
          detail: `'${name}' is both in the --filter list and on the exclusion list in ${SELF} — one of the two is wrong`,
        });
      else if (!filters.has(name) && !EXCLUDED.has(name))
        violations.push({
          file: CI_WORKFLOW,
          line,
          rule: "ci-test-filters",
          detail: `'${name}' defines a 'test' script but the checks job neither runs it nor excludes it — add --filter=${name} here, or add it to EXCLUDED in ${SELF} with the reason it cannot run`,
        });
    }
    for (const [name, reason] of EXCLUDED) {
      if (testable.has(name)) continue;
      const known = all.some((one) => one.name === name);
      violations.push({
        file: SELF,
        line: exclusionLine(name),
        rule: "ci-test-filters",
        detail: known
          ? `'${name}' no longer defines a 'test' script, so excluding it ("${reason}") says nothing — drop the entry`
          : `'${name}' is not a workspace — renamed or removed; fix the entry rather than the workspace`,
      });
    }
    return violations;
  },
};
