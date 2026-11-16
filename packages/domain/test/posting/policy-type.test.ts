import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";
import { describe, expect, it } from "vitest";
import { POLICY_TYPE_BANNER, POLICY_TYPE_OPTIONS } from "../../scripts/policy-type-options";

/** Comments and whitespace are formatting, not type; the comparison is the WHOLE text otherwise. */
const normalise = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();

describe("src/posting/policy.ts is generated, not hand-written", () => {
  it("regenerating produces no diff (the committed-artifact discipline of spec:2055)", () => {
    const path = fileURLToPath(new URL("../../src/posting/policy.ts", import.meta.url));
    const before = readFileSync(path, "utf8");
    execFileSync("bun", ["run", "policy:types"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("the committed PostingPolicy type is what the current schema generates (contracts §4.18)", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../../posting-policy.schema.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    const generated = await compile(schema, "PostingPolicy", POLICY_TYPE_OPTIONS);
    const onDisk = await readFile(new URL("../../src/posting/policy.ts", import.meta.url), "utf8");
    // The committed file is BANNER + generated. Strip exactly that banner — not "any leading // lines" —
    // so a hand-added comment at the top of the file is drift and is reported as drift. The comparison is
    // the WHOLE normalised text: the thirteen-member accountRef and amountRef unions sit well past the first
    // few hundred characters, and a prefix comparison would be blind to exactly the drift a widening causes.
    expect(onDisk.startsWith(POLICY_TYPE_BANNER)).toBe(true);
    const committed = onDisk.slice(POLICY_TYPE_BANNER.length);
    expect(normalise(committed)).toBe(normalise(generated));
  });
});
