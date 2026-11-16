import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../packages/db/seed/roles";
import { startDb, type Db } from "@dulja/db/test";

describe("5B — accounting.tax.file (§3.6.2, contracts amendment 8)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await startDb();
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("is in the catalogue exactly once, mutating, module accounting, phase 5B", () => {
    const rows = PERMISSIONS.filter((p) => p.code === "accounting.tax.file");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.module).toBe("accounting");
    expect(rows[0]!.mutating).toBe(true);
    expect(rows[0]!.phase).toBe("5B");
  });

  it("is in app.permission with the same (module, mutating) after 0058", async () => {
    const [row] = await db.admin<{ module: string; mutating: boolean }[]>`
      select module, mutating from app.permission where code = 'accounting.tax.file'`;
    expect(row).toBeDefined();
    expect(row!.module).toBe("accounting");
    expect(row!.mutating).toBe(true);
  });

  it("is granted to accountant and to nobody else in the seed (spec:2158, amendment 8)", () => {
    const holders = ROLES.filter(
      (r) => r.code !== "admin" && r.permissions.includes("accounting.tax.file"),
    );
    expect(holders.map((r) => r.code)).toEqual(["accountant"]);
  });

  it("keeps R7: auditor holds no mutating code", () => {
    const auditor = ROLES.find((r) => r.code === "auditor")!;
    const mutating = auditor.permissions.filter(
      (c) => PERMISSIONS.find((p) => p.code === c)?.mutating === true,
    );
    expect(mutating).toEqual([]);
  });

  it("introduces no incompatible pair (R6)", () => {
    for (const role of ROLES) {
      if (role.code === "admin") continue;
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(
          role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`,
        ).toBe(false);
      }
    }
  });
});
