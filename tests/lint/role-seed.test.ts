import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/role-seed";
import type { SourceFile } from "../../scripts/lint/types";

const file = (path: string, text: string): SourceFile => ({
  path,
  text,
  lines: text.split(/\r?\n/),
});
const catalogue = file(
  "packages/contracts/permissions.ts",
  `
  { code: "accounting.payment.create", mutating: true },
  { code: "accounting.payment.approve", mutating: true },
  { code: "admin.audit_log.read", mutating: false }`,
);
const roles = (body: string) =>
  file(
    "packages/db/seed/roles.ts",
    `
  export const ROLES = [${body}];
  export const INCOMPATIBLE_PAIRS = [
    ["accounting.payment.create", "accounting.payment.approve"],
    ["hr.payroll.prepare", "hr.payroll.approve"]
  ];`,
  );

describe("role-seed lint", () => {
  it("passes a clean seed", () => {
    expect(
      rule.run([
        catalogue,
        roles(`
      { code: "admin", permissions: [] },
      { code: "accountant", permissions: ["accounting.payment.approve"] },
      { code: "auditor", permissions: ["admin.audit_log.read"] }`),
      ]),
    ).toEqual([]);
  });
  it("reports a live incompatible pair", () => {
    expect(
      rule.run([
        catalogue,
        roles(
          `{ code: "accountant", permissions: ["accounting.payment.create", "accounting.payment.approve"] }`,
        ),
      ]),
    ).toHaveLength(1);
  });
  it("a comment inside a permissions array hides nothing — quotes, brackets or the word INCOMPATIBLE_PAIRS", () => {
    expect(
      rule.run([
        catalogue,
        roles(`
      { code: "accountant", permissions: [
        // R6 (INCOMPATIBLE_PAIRS) forbids this pair; the clerk's "create" [drafts] it.
        /* a block comment with a ] and a ' */
        "accounting.payment.create",
        "accounting.payment.approve",
      ] }`),
      ]),
    ).toHaveLength(1);
  });
  it("exempts admin from incompatible pairs", () => {
    expect(
      rule.run([
        catalogue,
        roles(
          `{ code: "admin", permissions: ["accounting.payment.create", "accounting.payment.approve"] }`,
        ),
      ]),
    ).toEqual([]);
  });
  it("skips pairs not live in this phase", () => {
    expect(
      rule.run([
        catalogue,
        roles(`{ code: "hr_payroll", permissions: ["hr.payroll.prepare", "hr.payroll.approve"] }`),
      ]),
    ).toHaveLength(2);
  });
  it("reports mutating auditor grants", () => {
    expect(
      rule.run([
        catalogue,
        roles(`{ code: "auditor", permissions: ["accounting.payment.approve"] }`),
      ]),
    ).toHaveLength(1);
  });
  it("reports uncatalogued grants", () => {
    expect(
      rule.run([catalogue, roles(`{ code: "user", permissions: ["accounting.ghost.post"] }`)]),
    ).toHaveLength(1);
  });
  it("is silent when either source file is absent", () => {
    expect(rule.run([catalogue])).toEqual([]);
    expect(rule.run([roles(`{ code: "admin", permissions: [] }`)])).toEqual([]);
  });
});

/** The tree's own two files, read from disk. */
const real = (path: string): SourceFile =>
  file(path, readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));

describe("role-seed lint over the real seed — 4A makes R6's payment pair live (contracts §3.6.3, §3.6.4)", () => {
  // The rule parses packages/db/seed/roles.ts textually, so the tree's file is exercised here rather than a
  // fixture: a comment that cut its parse short would drop every later role from the check and still report
  // zero violations, which is exactly how this case was found during 4A Task 2.
  it("the committed seed is clean", () => {
    expect(
      rule.run([real("packages/contracts/permissions.ts"), real("packages/db/seed/roles.ts")]),
    ).toEqual([]);
  });

  it("refuses accounting.payment.create on accountant, beside its accounting.payment.approve (R6, spec:2177)", () => {
    const seed = real("packages/db/seed/roles.ts");
    const anchor = `"accounting.payment.approve",`;
    expect(seed.text).toContain(anchor);
    const injected = file(
      seed.path,
      seed.text.replace(anchor, `${anchor}\n      "accounting.payment.create",`),
    );
    const violations = rule.run([real("packages/contracts/permissions.ts"), injected]);
    expect(violations.map((violation) => violation.detail)).toEqual([
      "role 'accountant' holds incompatible pair 'accounting.payment.create' + 'accounting.payment.approve'",
    ]);
  });
});
