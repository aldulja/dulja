import { readdirSync } from "node:fs";
import { sourceFiles } from "./source";
import type { LintRule } from "./types";

// Every module in rules/ runs. The plan asked for the directory to be the registry (plan0B Task 12) and a
// hand-written import list had replaced it, so a rule file could be added and silently never run — which is
// indistinguishable from a rule that passes. Sorted, so the violation order is stable across machines.
const directory = new URL("rules/", import.meta.url);
const rules: LintRule[] = [];
for (const entry of readdirSync(directory)
  .filter((name) => name.endsWith(".ts"))
  .toSorted()) {
  const module = (await import(new URL(entry, directory).href)) as { rule: LintRule };
  rules.push(module.rule);
}

const files = sourceFiles();
const targets = files.filter((file) => !file.path.startsWith("scripts/lint/"));
const violations = rules.flatMap((rule) => rule.run(targets));
for (const item of violations)
  process.stderr.write(`${item.file}:${item.line} ${item.rule} ${item.detail}\n`);
if (violations.length) process.exit(1);
process.stdout.write(`${rules.length} rules, ${files.length} files, 0 violations\n`);
