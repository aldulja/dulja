import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");

interface AccountSeed {
  code: string;
  nameEn: string;
  nameAr?: string;
  type: string;
  parentCode?: string;
  isGroup?: boolean;
}

/** The pack file under test, re-read per case so no case can observe another's mutation. */
function packRows(): AccountSeed[] {
  return JSON.parse(
    readFileSync(join(PACK_ROOT, "chart-of-accounts", "3c-purchasing.json"), "utf8"),
  ) as AccountSeed[];
}

let db: Db;
let s: Seed;

/** The `only` member is the CLI's `--only chart-of-accounts`; every other member is a fixture value. */
function loaderContext() {
  return {
    config: {
      tenantId: s.tenant,
      only: ["chart-of-accounts"] as const,
      packRoot: PACK_ROOT,
      appEnv: "dev" as const,
      tenantName: "coa-3c",
      ownerEmail: "owner@example.invalid",
      companyCode: "HQ",
      companyName: "coa-3c HQ",
      baseCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
      fiscalYearStartMonth: 1,
      fiscalYear: 2026,
    },
    tenantId: s.tenant,
    companyId: s.company,
    systemPrincipalId: s.system,
    packRoot: PACK_ROOT,
  };
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "coa-3c");
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("chart-of-accounts/3c-purchasing.json — contracts §4.15", () => {
  it("carries exactly the three rows §4.15 assigns 3C, with the right types", () => {
    const rows = packRows();
    expect(rows.map((r) => [r.code, r.type])).toEqual([
      ["2150", "liability"],
      ["1310", "asset"],
      ["5100", "expense"],
    ]);
    expect(rows.every((r) => r.nameAr !== undefined && r.nameAr.length > 0)).toBe(true);
    expect(rows.every((r) => r.isGroup !== true)).toBe(true);
  });

  it("every code matches ^[1-5][0-9]{3}$ and its first digit is its account_type (§4.15, frozen)", () => {
    const firstDigit: Record<string, string> = {
      asset: "1",
      liability: "2",
      equity: "3",
      income: "4",
      expense: "5",
    };
    for (const r of packRows()) {
      expect(r.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(r.code[0]).toBe(firstDigit[r.type]);
    }
  });

  it("hangs each row off a 0C parent and edits no 0C file (§4.15's file-per-slice layout)", () => {
    expect(packRows().map((r) => r.parentCode)).toEqual(["2100", "1300", "5000"]);
    const base = JSON.parse(
      readFileSync(join(PACK_ROOT, "chart-of-accounts", "0c-base.json"), "utf8"),
    ) as AccountSeed[];
    for (const code of ["2150", "1310", "5100"])
      expect(
        base.map((r) => r.code),
        code,
      ).not.toContain(code);
  });

  it("the loader applies the file and the three accounts resolve for the company (hazard 33)", async () => {
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, loaderContext()),
    );
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx<
          { code: string; type: string }[]
        >`select code, type::text as type from app.account where company_id = ${s.company} and code in ('2150','1310','5100') order by code`,
    );
    expect(rows).toEqual([
      { code: "1310", type: "asset" },
      { code: "2150", type: "liability" },
      { code: "5100", type: "expense" },
    ]);
  });

  it("1300 inventory control (0C's) also resolves — GOODS_RECEIPT and SHIPMENT name it by literal", async () => {
    // Hazard 33 in the other direction: this slice's receipt policies carry TWO `account: { code }` literals,
    // `2150` (seeded above) and `1300` (0C's `0c-base.json`, seeded before this slice runs). The rule for a
    // consumed code is "assert it resolves in your first task in that area; never re-seed it, never fall back
    // to a null account" — so this case is the assertion and `3c-purchasing.json` deliberately omits `1300`.
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; type: string }[]>`
      select code, type::text as type from app.account where company_id = ${s.company} and code = '1300'`,
    );
    expect(row).toEqual({ code: "1300", type: "asset" });
    expect(packRows().map((r) => r.code)).not.toContain("1300");
  });

  it("re-applying the pack is idempotent on (company_id, code) — spec:2002", async () => {
    const before = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company}`,
    );
    const applied = await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, loaderContext()),
    );
    expect(applied).toBe(0);
    const after = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company}`,
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
