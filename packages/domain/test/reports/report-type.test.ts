import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { describe, expect, it } from "vitest";
import { REPORT_TYPE_BANNER, REPORT_TYPE_OPTIONS } from "../../scripts/policy-type-options";

/** Comments and whitespace are formatting, not type; the comparison is the WHOLE text otherwise. */
const normalise = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("src/reports/definition.ts is generated, not hand-written", () => {
  it("regenerating produces no diff (the committed-artifact discipline of spec:2055)", () => {
    const path = fileURLToPath(new URL("../../src/reports/definition.ts", import.meta.url));
    const before = readFileSync(path, "utf8");
    execFileSync("bun", ["run", "report:types"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("the committed ReportDefinition type is what the current schema generates (contracts §4.11.1)", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../../report-definition.schema.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const generated = await compile(schema, "ReportDefinition", REPORT_TYPE_OPTIONS);
    const onDisk = await readFile(
      new URL("../../src/reports/definition.ts", import.meta.url),
      "utf8",
    );
    // The committed file is BANNER + generated; strip exactly that banner, so a hand-added comment at the top
    // is drift and is reported as drift.
    expect(onDisk.startsWith(REPORT_TYPE_BANNER)).toBe(true);
    expect(normalise(onDisk.slice(REPORT_TYPE_BANNER.length))).toBe(normalise(generated));
  });
});
