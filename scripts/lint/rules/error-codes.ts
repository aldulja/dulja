import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERRORS } from "../../../packages/contracts/src/errors";
import type { LintRule, LintViolation } from "../types";

const REGISTRY = "packages/contracts/src/errors.ts";
const LITERAL_START = "export const ERRORS = {";
const LITERAL_END = "} as const satisfies Record<string, ErrorDef>;";
const MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

function searchable(file: { path: string; text: string }): string {
  if (file.path !== REGISTRY) return file.text;
  const start = file.text.indexOf(LITERAL_START);
  const end = start === -1 ? -1 : file.text.indexOf(LITERAL_END, start);
  if (start === -1 || end === -1) return "";
  return file.text.slice(0, start) + file.text.slice(end + LITERAL_END.length);
}

function migrationText(): string {
  return readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => readFileSync(join(MIGRATIONS, file), "utf8"))
    .join("\n");
}

// The haystack is every file `scripts/lint/source.ts` hands the rule — all of `apps`, `packages` and `scripts` (bar
// `scripts/lint` itself) — plus the migrations. There is no narrower root list, so `packages/domain/payroll/**`, which
// sits outside `src/` by design (spec:2366) and is where PayrollCalculationError raises the two ERR_PAYROLL_* codes,
// is read like any other file (contracts round 17, A16; `scripts/lint/lint.test.ts` pins it).
export const rule: LintRule = {
  name: "error-codes",
  run(files) {
    const haystack = `${files.map(searchable).join("\n")}\n${migrationText()}`;
    return Object.keys(ERRORS)
      .filter((code) => !haystack.includes(code))
      .map((code): LintViolation => ({
        file: REGISTRY,
        line: 1,
        rule: "error-codes",
        detail: `${code} is in ERRORS but nothing raises it — remove it or raise it`,
      }));
  },
};
