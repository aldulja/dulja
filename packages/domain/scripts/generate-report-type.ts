import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { REPORT_TYPE_BANNER, REPORT_TYPE_OPTIONS } from "./policy-type-options";

/** Regenerates src/reports/definition.ts from report-definition.schema.json (7A Task 4). The banner and the
 *  compile options live in ./policy-type-options.ts beside the posting policy's, so this generator and its
 *  drift guard (test/reports/report-type.test.ts) cannot disagree about how the type is produced. */
const root = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(await readFile(`${root}report-definition.schema.json`, "utf8")) as Record<
  string,
  unknown
>;
const ts = await compile(schema, "ReportDefinition", REPORT_TYPE_OPTIONS);
await writeFile(`${root}src/reports/definition.ts`, REPORT_TYPE_BANNER + ts, "utf8");
