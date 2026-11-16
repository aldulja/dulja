import { describe, expect, it } from "vitest";
import { costingContext } from "./support/costing";

const ctx = costingContext("061"); // ← this file's own LEGACY number

describe("LEGACY-061 A repair that reset every cost to its opening value, permanently — 3B", () => {
  // first proven by spec:721, spec:1210
  it("the replay recomputes from the movements — there is no 'reset to opening' path at all", async () => {
    const files = await ctx.sourceFiles(["packages/db/src/costing"]);
    // No statement sets a layer's unit_cost from anything but the movement it derives from.
    for (const f of files) {
      for (const line of f.text.split("\n").filter((l) => /set\s+unit_cost/.test(l))) {
        expect(line).not.toMatch(/opening|initial|seed/i);
      }
    }
  });
});
