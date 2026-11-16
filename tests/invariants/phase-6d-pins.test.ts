// tests/invariants/phase-6d-pins.test.ts — THREE cases, at the tier that may import all three sources.
// §3.1's table: "`tests` — imports any package and `apps/api` only through its exported entry points
// `createApp()` and `./routes` (never a route file)". `probes.ts` is a sibling of this file.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JOBS } from "@dulja/db";
import { ReportCodeSchema } from "@dulja/contracts/accounting/reports";
import { ROUTES } from "@dulja/api/routes";
import { REPO_ROOT } from "../support/source";
import { PROBES } from "./probes";

// `ROUTES` is derived from `buildRoutes` with the stub auth adapter (§4.2.7); importing the derived const
// would be the same call, and this spelling matches 0B's own route tests. No database, so no `startDb`
// and no timeout — every case here is synchronous.

describe("6D pins (contracts and route tier)", () => {
  it("this slice registered NO job: JOBS is still the closed sixteen", () => {
    expect(Object.keys(JOBS)).toHaveLength(16);
    expect(Object.keys(JOBS).filter((n) => /till|shift|pos\.z/.test(n))).toEqual([]);
  });

  it("6D mounted exactly ONE new route module and it has exactly one PROBES key", () => {
    const mine = ROUTES.filter((r) => r.path.endsWith("/shifts"));
    expect(mine).toHaveLength(1);
    expect(PROBES[mine[0]!.path]).toBeDefined();
    // And the two report GETs added no key: they are sub-paths of 1B's module (hazard 31).
    expect(ROUTES.filter((r) => r.path.endsWith("/reports"))).toHaveLength(1);
  });

  it("ReportCodeSchema names both 6D codes and 6D seeded no ReportDefinition", () => {
    expect(ReportCodeSchema.options).toContain("pos.z_report");
    expect(ReportCodeSchema.options).toContain("pos.sales_by_cashier");
    expect(existsSync(join(REPO_ROOT, "packages/db/seed/my/reports/6d"))).toBe(false);
  });
});
