import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PHYSICAL_PROPERTY_PATTERNS } from "../../packages/ui/src/tailwind-preset";

/**
 * §5.0 row 0.12 is "a screen renders correctly in both directions", and the screens live in
 * `apps/backoffice/src`. `packages/ui/test/logical-properties.test.ts` runs the same blocklist over
 * `packages/ui/src` — the four primitives and the grid — and can only ever run over that tree: the
 * dependency rule forbids `packages/ui` reaching into `apps/backoffice`. So the half of row 0.12 that
 * covers the actual screens has to live out here, beside `lint-rules.test.ts`, which re-runs
 * `no-hardcoded-string` over both shipped trees for exactly the same reason (0E final review).
 *
 * The blocklist itself is imported rather than re-spelled: two copies drifting apart would be worse
 * than one copy with a gap.
 */
/**
 * The two trees that hold screens. The till's renderer joined in 6B T11: its stylesheet is its own
 * (`apps/pos/src/renderer/app.css`), and `tests/e2e/pos-rtl-parity.spec.ts` measures the result in a real
 * engine; this is the cheap, browserless half of the same rule.
 */
const TREES = [
  { name: "apps/backoffice/src", proof: "DoD 0.12" },
  { name: "apps/pos/src/renderer", proof: "6B T11" },
] as const;

/** Every source file under the screens tree, recursively. `.css` is included deliberately —
 *  `app.css` is where a physical `margin-left` would land, and it is the file most likely to carry
 *  one, since Tailwind utilities are not involved there. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (/\.(tsx?|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const offendersIn = (label: string, text: string): string[] =>
  text
    .split(/\r?\n/)
    .flatMap((content, index) =>
      PHYSICAL_PROPERTY_PATTERNS.filter((pattern) => new RegExp(pattern).test(content)).map(
        (pattern) => `${label}:${index + 1} matches /${pattern}/ — ${content.trim()}`,
      ),
    );

for (const tree of TREES) {
  const SRC = resolve(__dirname, "../..", tree.name);
  const files = collectFiles(SRC);

  describe(`logical properties only — ${tree.name} (${tree.proof})`, () => {
    it("found the screens to scan — a relocated or emptied src/ must not pass silently", () => {
      expect(files.length).toBeGreaterThan(0);
      // Named explicitly rather than trusted to the extension filter: the stylesheet is the one file
      // here where a physical property is written as CSS rather than as a Tailwind utility, so a glob
      // that quietly stopped matching `.css` would take the most likely offender out of scope.
      expect(files.map((file) => relative(SRC, file).replaceAll("\\", "/"))).toContain("app.css");
    });

    it("the imported blocklist still rejects something — this suite must not go vacuously green", () => {
      // Neuter every pattern to "$^" and the assertion below stays green for ever. This is the positive
      // control that fails instead.
      expect(offendersIn("sample.tsx", 'className="ml-2"')).not.toEqual([]);
      expect(offendersIn("sample.css", "margin-left: 4px;")).not.toEqual([]);
    });

    it("no screen uses a physical Tailwind utility or CSS property", () => {
      const offenders = files.flatMap((file) =>
        offendersIn(relative(SRC, file).replaceAll("\\", "/"), readFileSync(file, "utf8")),
      );
      expect(offenders).toEqual([]);
    });
  });
}
