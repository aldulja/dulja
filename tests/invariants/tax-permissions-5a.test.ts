import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/source";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../packages/db/seed/roles";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { lintSchema, listApplied } from "@dulja/db";
import { readPackFile } from "@dulja/db/seed";
import { startDb, withTenant, type Db } from "@dulja/db/test";
import { seedAccount, seedTenantV2, type Seed } from "@dulja/db/test";

const seededRole = (code: string) => ROLES.find((r) => r.code === code)!;

type AccountSeed = {
  code: string;
  nameEn: string;
  nameAr?: string;
  type: string;
  parentCode?: string;
  isGroup?: boolean;
};

/** The two §4.15 rows this slice SEEDS. */
const SEEDED = [
  { code: "2300", nameEn: "Output tax payable", type: "liability" },
  { code: "1350", nameEn: "Input tax receivable", type: "asset" },
] as const;

/** Codes this slice's policies, services and tests RESOLVE and never re-seed (hazard 33), with the owner. */
const CONSUMED = [
  { code: "1200", type: "asset", seededBy: "0C" }, // party.receivable_account, the AR leg
  { code: "2100", type: "liability", seededBy: "0C" }, // party.payable_account, the AP leg
  { code: "4000", type: "income", seededBy: "0C" }, // item.revenue_account
  { code: "5000", type: "expense", seededBy: "0C" }, // item.cogs_account
  { code: "1300", type: "asset", seededBy: "0C" }, // item.inventory_account
  { code: "5920", type: "expense", seededBy: "0C" }, // company.fx_rounding_account_id, via balanceInBase
] as const;

let db: Db;
let s: Seed;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "perm-5a");
}, 180_000);
afterAll(async () => {
  await db?.stop();
});

describe("migration 0056 — accounting.tax.manage (§3.6.2, §3.6.3)", () => {
  it("applies as version 56", async () => {
    expect(await listApplied(db.migrator)).toContain(56);
  });

  it("app.permission carries exactly one 5A row, and it is mutating", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = 'accounting.tax.manage' order by code`;
    expect(rows).toEqual([{ code: "accounting.tax.manage", module: "accounting", mutating: true }]);
  });

  it("0056 seeds only the 5A code; the filing code belongs to 0058", () => {
    expect(
      readFileSync(
        new URL("../../packages/db/migrations/0056_seed_permission_phase5a.sql", import.meta.url),
        "utf8",
      ),
    ).not.toContain("accounting.tax.file");
  });

  it("the catalogue module agrees with the database, both directions", () => {
    expect(PERMISSIONS.find((p) => p.code === "accounting.tax.manage")).toMatchObject({
      module: "accounting",
      mutating: true,
      phase: "5A",
    });
  });

  it("accountant holds it; auditor does not, because it is mutating (R7, spec:2163)", () => {
    expect(seededRole("accountant").permissions).toContain("accounting.tax.manage");
    for (const other of [
      "auditor",
      "user",
      "warehouse",
      "cashier",
      "branch_manager",
      "hr_payroll",
      "pos_terminal",
    ]) {
      expect(seededRole(other).permissions, other).not.toContain("accounting.tax.manage");
    }
  });

  it("no seeded role other than admin holds an incompatible pair (R6, spec:2177)", () => {
    for (const role of ROLES.filter((r) => r.code !== "admin")) {
      for (const [x, y] of INCOMPATIBLE_PAIRS) {
        expect(
          role.permissions.includes(x) && role.permissions.includes(y),
          `${role.code} holds both ${x} and ${y}`,
        ).toBe(false);
      }
    }
  });

  it("5a-tax.json is this slice's OWN chart file and holds exactly the two §4.15 rows", () => {
    const packRoot = join(REPO_ROOT, "packages/db/seed/my"); // packages/db is this workspace's cwd
    const rows = readPackFile<AccountSeed[]>(packRoot, "chart-of-accounts", "5a-tax.json");
    expect(rows.map((r) => r.code).toSorted()).toEqual(["1350", "2300"]);
    for (const want of SEEDED) {
      const got = rows.find((r) => r.code === want.code)!;
      expect(got.nameEn).toBe(want.nameEn);
      expect(got.type).toBe(want.type);
      expect(got.isGroup).toBeUndefined();
      expect(got.nameAr, `${want.code} needs an Arabic label (spec:2045)`).toBeTruthy();
      // §4.15's first-digit rule: the code and the type can never disagree.
      expect(got.code[0]).toBe(
        { asset: "1", liability: "2", equity: "3", income: "4", expense: "5" }[got.type],
      );
    }
  });

  it("0C's shipped chart pack declares every code this slice CONSUMES, and neither of the two it seeds", () => {
    // Reading 0C's own file is what makes hazard 33 bind: seeding the accounts in the test and then
    // asserting they resolve is self-fulfilling and could never detect 0C dropping a row.
    const packRoot = join(REPO_ROOT, "packages/db/seed/my");
    const base = readPackFile<AccountSeed[]>(packRoot, "chart-of-accounts", "0c-base.json");
    const leaves = new Map(base.filter((r) => r.isGroup !== true).map((r) => [r.code, r]));
    for (const c of CONSUMED) {
      expect(
        leaves.has(c.code),
        `0c-base.json has no leaf ${c.code} — ${c.seededBy} dropped a §4.15 row`,
      ).toBe(true);
      expect(leaves.get(c.code)!.type, c.code).toBe(c.type);
    }
    for (const mine of SEEDED) {
      expect(
        leaves.has(mine.code),
        `${mine.code} is 5A's row and must not be in 0c-base.json`,
      ).toBe(false);
    }
  });

  it("every consumed code resolves for a seeded company, and this slice re-seeds none (hazard 33)", async () => {
    for (const c of CONSUMED)
      await seedAccount(db, s, { code: c.code, nameEn: c.code, type: c.type as never });
    for (const m of SEEDED)
      await seedAccount(db, s, { code: m.code, nameEn: m.nameEn, type: m.type as never });
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      const rows = await tx<{ code: string; type: string }[]>`
        select code, type from app.account where company_id = ${s.company}
           and code = any(${[...CONSUMED, ...SEEDED].map((c) => c.code)}::text[]) order by code`;
      expect(rows.map((r) => r.code)).toEqual([
        "1200",
        "1300",
        "1350",
        "2100",
        "2300",
        "4000",
        "5000",
        "5920",
      ]);
      expect(rows.find((r) => r.code === "2300")!.type).toBe("liability");
      expect(rows.find((r) => r.code === "1350")!.type).toBe("asset");
    });
  });

  it("no other 5a chart file exists — one file per contributing slice (§4.15)", async () => {
    const { readdirSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const dir = fileURLToPath(
      new URL("../../packages/db/seed/my/chart-of-accounts/", import.meta.url),
    );
    expect(readdirSync(dir).filter((f) => f.startsWith("5a-"))).toEqual(["5a-tax.json"]);
  });

  it("lintSchema reports zero violations after 0056", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
