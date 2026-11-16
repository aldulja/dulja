import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { POLICY_TYPE_BANNER, POLICY_TYPE_OPTIONS } from "./policy-type-options";

/** Regenerates src/posting/policy.ts from posting-policy.schema.json. CI runs this and fails on a diff, so the
 *  committed type can never drift from the schema (the same discipline as the committed openapi.json, spec:2055).
 *  The banner and the compile options live in ./policy-type-options.ts, shared with the drift guard in
 *  test/posting/policy-type.test.ts, so the two cannot disagree about how the type is produced (2A). */
const root = fileURLToPath(new URL("..", import.meta.url));
const schema = JSON.parse(await readFile(`${root}posting-policy.schema.json`, "utf8")) as Record<
  string,
  unknown
>;
const ts = await compile(schema, "PostingPolicy", POLICY_TYPE_OPTIONS);
await writeFile(`${root}src/posting/policy.ts`, POLICY_TYPE_BANNER + ts, "utf8");
