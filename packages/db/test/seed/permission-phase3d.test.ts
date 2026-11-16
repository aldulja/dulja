import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import {
  DELIVERY_ORDER_POLICY,
  EXPIRY_WRITE_OFF_POLICY,
  GRN_POLICY,
  SALES_ORDER_POLICY,
  TRANSFER_POLICY,
} from "../inventory/policies";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const TYPES_DIR = join(PACK_ROOT, "document-types");

/** The six codes contracts §3.6.2 assigns 3D, in the order `order by code` returns them. */
const CODES = [
  "accounting.sales.create",
  "inventory.adjustment.approve",
  "inventory.adjustment.create",
  "inventory.count.create",
  "inventory.transfer.create",
  "inventory.transfer.post",
] as const;

interface AccountSeedRow {
  code: string;
  nameEn: string;
  nameAr: string;
  type: string;
  parentCode?: string;
}

/** The pack file under test, re-read per case so no case can observe another's mutation. */
function packRows(): AccountSeedRow[] {
  return JSON.parse(
    readFileSync(join(PACK_ROOT, "chart-of-accounts", "3d-adjustments.json"), "utf8"),
  ) as AccountSeedRow[];
}

let db: Db;
let s: Seed;

/** The seeded grants of one role, by role code. Hoisted out of the describe: oxlint's
 *  `unicorn/consistent-function-scoping` refuses a non-closing function declared inside a test callback. */
const of = (role: string): readonly string[] =>
  ROLES.find((candidate) => candidate.code === role)!.permissions;

/** The `only` member is the CLI's `--only chart-of-accounts`; every other member is a fixture value. */
function loaderContext() {
  return {
    config: {
      tenantId: s.tenant,
      only: ["chart-of-accounts"] as const,
      packRoot: PACK_ROOT,
      appEnv: "dev" as const,
      tenantName: "perm-3d",
      ownerEmail: "owner@example.invalid",
      companyCode: "HQ",
      companyName: "perm-3d HQ",
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

describe("slice 3D permission seed and chart additions (contracts §3.6.2, §3.6.4, §4.15)", () => {
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "tenant-3d");
    // 0C's chart-of-accounts loader, applied for this tenant so 0C's, 3C's and 3D's files all land.
    // Idempotent on (company_id, code) — contracts §3.4.8.
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, loaderContext()),
    );
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  it("migration 0041 seeded exactly the six codes, all mutating", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = any(${[...CODES]}) order by code`;
    expect(rows.map((row) => row.code)).toEqual([...CODES]);
    expect(rows.every((row) => row.mutating)).toBe(true);
    expect(rows.map((row) => row.module)).toEqual([
      "accounting",
      "inventory",
      "inventory",
      "inventory",
      "inventory",
      "inventory",
    ]);
  });

  // The catalogue half — that packages/contracts/permissions.ts carries the same six rows, all mutating and
  // all `phase: "3D"` — is asserted in packages/contracts/test/contracts.test.ts, not here: 0B's
  // `dependency-rule` lets exactly one file in this workspace import @dulja/contracts
  // (permission-catalogue.test.ts, where the both-directions equality with app.permission lives).

  it("roles.ts carries exactly the §3.6.4 grants and no others", () => {
    expect(of("user")).toContain("accounting.sales.create");
    expect(of("accountant")).toContain("inventory.adjustment.approve");
    expect(of("accountant")).not.toContain("inventory.adjustment.create");
    for (const role of ["warehouse", "branch_manager"]) {
      expect(of(role)).toContain("inventory.transfer.create");
      expect(of(role)).toContain("inventory.transfer.post");
      expect(of(role)).toContain("inventory.count.create");
      expect(of(role)).toContain("inventory.adjustment.create");
      expect(of(role)).not.toContain("inventory.adjustment.approve");
    }
    expect(of("auditor").filter((code) => (CODES as readonly string[]).includes(code))).toEqual([]);
  });

  it("no seeded role other than admin holds both codes of an incompatible pair (R6)", () => {
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin")) {
      for (const [left, right] of INCOMPATIBLE_PAIRS) {
        expect(
          role.permissions.includes(left) && role.permissions.includes(right),
          `${role.code} holds both ${left} and ${right}`,
        ).toBe(false);
      }
    }
  });

  it("3d-adjustments.json declares exactly 1250 and 5110, with the §4.15 first-digit rule", () => {
    const rows = packRows();
    expect(rows.map((row) => row.code).toSorted()).toEqual(["1250", "5110"]);
    const firstDigit: Record<string, string> = {
      "1": "asset",
      "2": "liability",
      "3": "equity",
      "4": "income",
      "5": "expense",
    };
    for (const row of rows) {
      expect(row.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(row.type).toBe(firstDigit[row.code[0]!]);
      expect(row.nameAr.length).toBeGreaterThan(0);
    }
  });

  it("every account code this slice's policies name resolves in the seeded company (hazard 33)", async () => {
    // 1250 and 5110 are 3D's (this task). 1310 and 5100 are 3C's. 1300, 5000 and 5920 are 0C's. The five
    // this slice does not own are ASSERTED, never re-seeded and never replaced by a null account.
    const need = ["1250", "1300", "1310", "5000", "5100", "5110", "5920"];
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string }[]>`
        select code from app.account where company_id = ${s.company} and code = any(${need}) order by code`,
    );
    expect(rows.map((row) => row.code)).toEqual(need);
    expect(packRows().map((row) => row.code)).not.toContain("1310");
    expect(packRows().map((row) => row.code)).not.toContain("5100");
  });

  it("every 3D document-type seed file's policy equals the constant this slice's tests configure", () => {
    // TRANSFER_RECEIPT and STOCK_COUNT are Task 8's files and Task 8's rows here; this task lists the four
    // that exist on disk when it lands, and Task 8 appends its two. A row whose file is missing fails the
    // case, which is the point — the list is not allowed to be silently short.
    const pairs: [string, unknown][] = [
      ["SALES_ORDER", SALES_ORDER_POLICY],
      ["DELIVERY_ORDER", DELIVERY_ORDER_POLICY],
      ["TRANSFER", TRANSFER_POLICY],
      ["EXPIRY_WRITE_OFF", EXPIRY_WRITE_OFF_POLICY],
    ];
    for (const [code, constant] of pairs) {
      const envelope = JSON.parse(readFileSync(join(TYPES_DIR, `${code}.json`), "utf8")) as {
        code: string;
        module: string;
        policy: unknown;
      };
      expect(envelope.code, `${code}.json's code`).toBe(code);
      expect(envelope.module, `${code}.json's module`).toBe("inventory");
      expect(envelope.policy, `${code}.json's policy vs the test constant`).toEqual(
        JSON.parse(JSON.stringify(constant)),
      );
    }
  });

  it("3C's GOODS_RECEIPT policy is what this slice's fixtures assume (a drift here is 3C's finding)", () => {
    const envelope = JSON.parse(readFileSync(join(TYPES_DIR, "GOODS_RECEIPT.json"), "utf8")) as {
      policy: unknown;
    };
    expect(envelope.policy).toEqual(JSON.parse(JSON.stringify(GRN_POLICY)));
  });
});
