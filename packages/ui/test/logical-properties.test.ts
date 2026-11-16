import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHYSICAL_PROPERTY_PATTERNS } from "../src/tailwind-preset";

const SRC = resolve(__dirname, "../src");

/**
 * Every source file under `src/`, recursively — a single-level `readdirSync` would silently stop
 * scanning a future subdirectory, and limiting the extension list to `.tsx`/`.css` would miss a
 * future `.ts` helper that builds a class string by hand. `tailwind-preset.ts` is excluded by name,
 * not extension: it *is* the blocklist, and its own explanatory comments (`// ml-/mr- → ms-/me-`,
 * and so on) are exactly the strings these patterns are designed to match — scanning it would be
 * testing the blocklist against itself, not testing the primitives it protects.
 */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (/\.(tsx?|css)$/.test(entry.name) && entry.name !== "tailwind-preset.ts")
      out.push(full);
  }
  return out;
}

const files = collectFiles(SRC);

describe("logical properties only", () => {
  it("exports the blocklist it is checked against", () => {
    expect(PHYSICAL_PROPERTY_PATTERNS.length).toBeGreaterThan(8);
  });

  it("found source files to scan — a relocated or emptied src/ must not pass silently", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("the blocklist actually rejects physical utilities and CSS properties — one sample per pattern", () => {
    // The "no primitive uses..." test below only proves the negative half: neuter every pattern to
    // "$^" (matches nothing) and that test stays green regardless. This is the positive control —
    // one fixture string per pattern, in the patterns' own declared order, so a single neutered
    // entry fails exactly that row instead of the whole rejection guarantee going dark silently.
    const samples: readonly string[] = [
      'className="ml-2"', // \bm[lr]-
      'className="pr-4"', // \bp[lr]-
      'className="left-0"', // \b(left|right)-\d
      'className="text-left"', // \btext-(left|right)\b
      'className="border-l"', // \bborder-[lr]\b
      'className="rounded-l"', // \brounded-[tb]?[lr]\b
      'className="float-right"', // \bfloat-(left|right)\b
      "margin-left: 4px;", // margin-(left|right)\s*:
      "padding-right: 4px;", // padding-(left|right)\s*:
      "left: 0;", // \b(left|right)\s*:\s*[^;]*;
      "text-align: left;", // text-align\s*:\s*(left|right)
    ];
    expect(samples).toHaveLength(PHYSICAL_PROPERTY_PATTERNS.length);
    PHYSICAL_PROPERTY_PATTERNS.forEach((pattern, index) => {
      const sample = samples[index]!;
      expect(
        new RegExp(pattern).test(sample),
        `pattern /${pattern}/ did not match "${sample}"`,
      ).toBe(true);
    });
  });

  it("no primitive uses a physical Tailwind utility or CSS property", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(".stories.tsx")) continue;
      const text = readFileSync(file, "utf8");
      for (const line of text.split(/\r?\n/).entries()) {
        const [index, content] = line;
        for (const pattern of PHYSICAL_PROPERTY_PATTERNS) {
          if (new RegExp(pattern).test(content)) {
            offenders.push(`${file}:${index + 1} matches /${pattern}/ — ${content.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
