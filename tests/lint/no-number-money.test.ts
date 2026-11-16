import { describe, expect, it } from "vitest";
import { rule } from "../../scripts/lint/rules/no-number-money";
import type { SourceFile } from "../../scripts/lint/types";

const source = (path: string, text: string): SourceFile => ({
  path,
  text,
  lines: text.split("\n"),
});

describe("no-number-money — spec §3.9 (SAH-008)", () => {
  it("flags declared money-ish number property, parameter, variable and return types", () => {
    const file = source(
      "packages/contracts/src/admin/thing.ts",
      `
      export interface Line { unitPrice: number; note: string }
      export function totalOf(totalAmount: number): number { return totalAmount }
      const exchangeRate: number = 4.68;
      export class Row { balance: number = 0 }
    `,
    );
    const found = rule.run([file]).map((violation) => violation.detail);
    expect(found).toHaveLength(5);
    expect(found[0]).toContain("'unitPrice' is typed number");
    expect(found.some((detail) => detail.includes("'totalOf' is typed number"))).toBe(true);
    expect(found.some((detail) => detail.includes("'balance' is typed number"))).toBe(true);
    expect(rule.run([file])[0]?.rule).toBe("no-number-money");
    expect(rule.run([file])[0]?.line).toBe(2);
  });

  it("flags number inside union and array annotations", () => {
    expect(
      rule.run([
        source(
          "apps/api/src/routes/admin/x.ts",
          `
      export interface A { taxAmount: number | null; costs: number[] }
    `,
        ),
      ]),
    ).toHaveLength(2);
  });

  it("accepts Money, Quantity, Decimal and string", () => {
    expect(
      rule.run([
        source(
          "packages/domain/src/x.ts",
          `
      export interface Line { unitPrice: Money; quantity: Quantity; rate: string; totalBase: Decimal }
    `,
        ),
      ]),
    ).toEqual([]);
  });

  it("ignores names that are not money-ish", () => {
    expect(
      rule.run([
        source(
          "apps/api/src/x.ts",
          "export interface Page { limit: number; offset: number; lineNo: number; retryLimit: number }",
        ),
      ]),
    ).toEqual([]);
  });

  // packages/db is where SQL numeric(19,4) becomes TypeScript, so a money-typed `number` there is
  // exactly SAH-008. The rule did not read that package at all until the Phase 0 review.
  it("reads packages/db, where a numeric column becomes a TypeScript value", () => {
    expect(
      rule.run([source("packages/db/src/x.ts", "export interface Row { totalAmount: number }")]),
    ).toEqual([
      expect.objectContaining({
        rule: "no-number-money",
        file: "packages/db/src/x.ts",
        detail: expect.stringContaining("'totalAmount' is typed number"),
      }),
    ]);
  });

  it("ignores declaration-shaped text in comments", () => {
    expect(
      rule.run([
        source("apps/api/src/x.ts", "// totalAmount: number\nexport const note = 'safe';"),
      ]),
    ).toEqual([]);
  });

  it("ignores declaration-shaped text in string literals", () => {
    expect(
      rule.run([source("apps/api/src/x.ts", 'export const note = "unitPrice: number";')]),
    ).toEqual([]);
  });

  it("flags quoted monetary property declarations", () => {
    expect(
      rule.run([
        source("packages/contracts/src/x.ts", 'export interface Line { "unit price": number }'),
      ]),
    ).toEqual([
      expect.objectContaining({
        rule: "no-number-money",
        detail: expect.stringContaining("'unit price' is typed number"),
      }),
    ]);
  });

  it("ignores files outside the scopes and every test file", () => {
    for (const path of [
      "scripts/lint/rules/x.ts",
      "packages/domain/test/x.ts",
      "apps/api/test/routes/x.test.ts",
      "apps/api/src/x.d.ts",
    ]) {
      expect(rule.run([source(path, "export interface A { totalAmount: number }")]), path).toEqual(
        [],
      );
    }
  });

  it("reports a printable file and 1-based line", () => {
    expect(
      rule.run([source("apps/api/src/a.ts", "export interface A {\n  netAmount: number;\n}")]),
    ).toEqual([
      {
        file: "apps/api/src/a.ts",
        line: 2,
        rule: "no-number-money",
        detail:
          "'netAmount' is typed number — a monetary or rate value must be Money, Quantity, Decimal or string (spec §3.9, SAH-008)",
      },
    ]);
  });
});
