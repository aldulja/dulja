import { readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";
import { RATE_TABLE_TYPE_BANNER, RATE_TABLE_TYPE_OPTIONS } from "./policy-type-options";

const SCHEMA = new URL("../payroll/rate-table.schema.json", import.meta.url);
const TARGET = new URL("../payroll/rate-table.ts", import.meta.url);

/** Regenerates payroll/rate-table.ts from payroll/rate-table.schema.json (8A Task 9). Exported so the drift guard
 *  (test/payroll/rate-table.test.ts) compares the WHOLE text against what this function produces — the banner and
 *  the compile options come from ./policy-type-options.ts, so the generator and its guard cannot disagree. */
export async function generateRateTableType(): Promise<string> {
  const schema = JSON.parse(await readFile(SCHEMA, "utf8")) as Record<string, unknown>;
  const body = await compile(schema, "RateTable", RATE_TABLE_TYPE_OPTIONS);
  return RATE_TABLE_TYPE_BANNER + body;
}

if (import.meta.main) await writeFile(TARGET, await generateRateTableType(), "utf8");
