// 8B T12 — ⚠️ OD-23 (§2.12, spec:2407): until the owner supplies accountant-signed tables, the only rate table in
// the repository is the clearly synthetic SYNTH (§4.12.4), loaded only by tests (hazard 1, spec:2080).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateRateTable } from "@dulja/domain/payroll";
import { SYNTH_RATE_TABLE_V1 } from "../fixtures";

// The repository root, computed locally: `packages/db` may not import the `tests` workspace (§3.1), and the
// 6D pins file computes it the same way.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const STATUTORY = join(REPO_ROOT, "packages/db/seed/my/statutory");
const SYNTH_FILE = join(REPO_ROOT, "packages/db/seed/test/statutory/SYNTH/v1.json");
const REAL_SCHEMES = ["EPF", "SOCSO", "EIS", "PCB"];

const synth = (): Record<string, unknown> =>
  JSON.parse(readFileSync(SYNTH_FILE, "utf8")) as Record<string, unknown>;

describe("OD-23 — no real statutory table exists until the owner supplies one (hazard 1, spec:2080)", () => {
  it("packages/db/seed/my/statutory/ holds 8A's catalogue files and NO rate table", () => {
    // 8A ships `schemes.json` (codes and names), `pay-components.json`, a README and one empty directory per §4.15
    // scheme (a `.gitkeep`). The plan's "absent or empty" predates that; what must not exist is a rate TABLE.
    if (!existsSync(STATUTORY)) return;
    const entries = readdirSync(STATUTORY).toSorted();
    for (const entry of entries) {
      const full = join(STATUTORY, entry);
      if (statSync(full).isDirectory()) {
        // A scheme directory is where `<SCHEME>/v<n>.json` lands with OD-23 and is empty until then.
        expect(readdirSync(full), `${entry}/ holds a rate table before OD-23`).toEqual([
          ".gitkeep",
        ]);
      } else {
        expect(["README.md", "pay-components.json", "schemes.json"]).toContain(entry);
      }
    }
  });

  it("no scheme directory anywhere in the seed packs holds a v<n>.json for a real authority's scheme", () => {
    const packs = join(REPO_ROOT, "packages/db/seed");
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/^v\d+\.json$/.test(entry) && REAL_SCHEMES.includes(basename(dir))) {
          found.push(full.slice(REPO_ROOT.length + 1));
        }
      }
    };
    walk(packs);
    expect(found).toEqual([]);
  });

  it("the SYNTH table validates against the §4.12.3 schema", () => {
    const result = validateRateTable(synth());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("the SYNTH table declares itself synthetic in BOTH the source and the verification", () => {
    const table = synth() as {
      scheme: string;
      source: { authority: string; url: string; publication: string };
      verification: { method: string };
    };
    // The scheme CODE is SYNTH and the display name SYNTHETIC-TEST-v1: `statutory_scheme.code` matches
    // ^[A-Z][A-Z0-9_]{1,15}$ and the display name (a hyphen, lower case) does not.
    expect(table.scheme).toBe("SYNTH");
    expect(table.source.publication).toContain("SYNTHETIC-TEST-v1");
    expect(table.source.authority).toBe("Dulja test fixture");
    expect(new URL(table.source.url).hostname.endsWith(".invalid")).toBe(true); // RFC 2606 — never resolves
    expect(table.verification.method).toBe("synthetic_test");
  });

  it("the file and the fixture constant every payroll test seeds are the SAME table", () => {
    // 8A's amendment A5 made SYNTH_RATE_TABLE_V1 the one home of a fixture's figures; this file is its on-disk twin
    // (§4.12.4). Only the provenance prose may differ.
    const { source: _fileSource, ...file } = synth();
    const { source: _constSource, ...constant } = SYNTH_RATE_TABLE_V1 as Record<string, unknown>;
    expect(file).toEqual(JSON.parse(JSON.stringify(constant)));
  });
});
