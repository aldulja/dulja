import type { LintRule, LintViolation, SourceFile } from "../types";

const CATALOGUE_FILE = "packages/contracts/permissions.ts";
const ROLE_SEED_FILE = "packages/db/seed/roles.ts";

function catalogue(file: SourceFile): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const entries =
    /\{[^{}]*?code\s*:\s*["']([^"']+)["'][^{}]*?mutating\s*:\s*(true|false)[^{}]*?\}/gs;
  for (const match of file.text.matchAll(entries)) result.set(match[1]!, match[2] === "true");
  return result;
}
/**
 * The source with every comment blanked to spaces (newlines kept, so line numbers still hold). The parsers
 * below are regular expressions over the text, and a comment inside a `permissions` array used to break them:
 * a quote mark read as a string, a `]` closed the array early, and the word `INCOMPATIBLE_PAIRS` ended the
 * ROLES section at the comment — which is how a role holding both codes of an R6 pair once linted clean.
 */
function withoutComments(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote !== null) {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[++i]!;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      if (i < text.length) out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const stop = close < 0 ? text.length : close + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else out += c;
  }
  return out;
}
function strings(input: string): string[] {
  return [...input.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
}
function roles(file: SourceFile): { code: string; permissions: string[]; line: number }[] {
  const text = withoutComments(file.text);
  const start = text.search(/export\s+const\s+ROLES\b/);
  if (start < 0) return [];
  const endAt = text.slice(start).search(/export\s+const\s+INCOMPATIBLE_PAIRS\b/);
  const section = text.slice(start, endAt < 0 ? undefined : start + endAt);
  const result: { code: string; permissions: string[]; line: number }[] = [];
  for (const match of section.matchAll(
    /\{[\s\S]*?\bcode\s*:\s*["']([^"']+)["'][\s\S]*?\bpermissions\s*:\s*\[([\s\S]*?)\][\s\S]*?\}/g,
  ))
    result.push({
      code: match[1]!,
      permissions: strings(match[2]!),
      line: text.slice(0, start + match.index).split(/\r?\n/).length,
    });
  return result;
}
function pairs(file: SourceFile): [string, string][] {
  const text = withoutComments(file.text);
  const start = text.search(/export\s+const\s+INCOMPATIBLE_PAIRS\b/);
  if (start < 0) return [];
  return [...text.slice(start).matchAll(/\[\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\]/g)].map(
    (match) => [match[1]!, match[2]!] as [string, string],
  );
}

export const rule: LintRule = {
  name: "role-seed",
  run(files): LintViolation[] {
    const catalogueFile = files.find((file) => file.path === CATALOGUE_FILE);
    const seedFile = files.find((file) => file.path === ROLE_SEED_FILE);
    if (!catalogueFile || !seedFile) return [];
    const codes = catalogue(catalogueFile);
    const violations: LintViolation[] = [];
    for (const role of roles(seedFile)) {
      for (const code of role.permissions) {
        if (!codes.has(code))
          violations.push({
            file: seedFile.path,
            line: role.line,
            rule: "role-seed",
            detail: `role '${role.code}' holds '${code}', which is not in the catalogue`,
          });
        else if (role.code === "auditor" && codes.get(code))
          violations.push({
            file: seedFile.path,
            line: role.line,
            rule: "role-seed",
            detail: `auditor holds mutating permission '${code}'`,
          });
      }
      if (role.code === "admin") continue;
      for (const [left, right] of pairs(seedFile)) {
        if (!codes.has(left) || !codes.has(right)) continue;
        if (role.permissions.includes(left) && role.permissions.includes(right))
          violations.push({
            file: seedFile.path,
            line: role.line,
            rule: "role-seed",
            detail: `role '${role.code}' holds incompatible pair '${left}' + '${right}'`,
          });
      }
    }
    return violations;
  },
};
