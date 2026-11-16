import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema, listApplied } from "../../src";
import { readPackFile } from "../../src/seed";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const CHART_DIR = join(PACK_ROOT, "chart-of-accounts");

/** The one code contracts §3.6.2 assigns 4B. The catalogue half — that packages/contracts/permissions.ts
 *  carries it with `phase: "4B"` and that migration 0052 seeds the module's own description — is asserted in
 *  packages/db/test/permission-catalogue.test.ts: 0B's `dependency-rule` lets exactly that one file in this
 *  workspace import @dulja/contracts. */
const CODE = "accounting.bank.reconcile";

/**
 * The six §4.15 codes this slice RESOLVES and does not seed, each with its seeding slice. FX_REVALUATION's
 * policy names no `account: { code }` literal, so these are the codes its drafting service (Task 5) and the
 * reconciler (Task 7) resolve — every one of them 0C's.
 */
const CONSUMED_ACCOUNTS = [
  { code: "1100", nameEn: "Bank", type: "asset", seededBy: "0C" },
  { code: "1200", nameEn: "Trade receivables (AR control)", type: "asset", seededBy: "0C" },
  { code: "2100", nameEn: "Trade payables (AP control)", type: "liability", seededBy: "0C" },
  { code: "4900", nameEn: "Foreign-exchange gain", type: "income", seededBy: "0C" },
  { code: "5910", nameEn: "Foreign-exchange loss", type: "expense", seededBy: "0C" },
  { code: "5920", nameEn: "FX rounding", type: "expense", seededBy: "0C" },
] as const;

/** §4.15's frozen code format: the first digit IS the account type. */
const FIRST_DIGIT: Record<string, string> = {
  asset: "1",
  liability: "2",
  equity: "3",
  income: "4",
  expense: "5",
};

let db: Db;
let s: Seed;

/** The seeded grants of one role, by role code. Hoisted out of the describe: oxlint's
 *  `unicorn/consistent-function-scoping` refuses a non-closing function declared inside a test callback. */
const of = (role: string): readonly string[] =>
  ROLES.find((candidate) => candidate.code === role)!.permissions;

/** The seeded non-admin roles holding one code, sorted. Hoisted for the same lint reason. */
const holders = (code: string): string[] =>
  ROLES.filter((role) => role.code !== "admin" && role.permissions.includes(code))
    .map((role) => role.code)
    .toSorted();

/** The `only` member is the CLI's `--only chart-of-accounts`; every other member is a fixture value. */
function loaderContext() {
  return {
    config: {
      tenantId: s.tenant,
      only: ["chart-of-accounts"] as const,
      packRoot: PACK_ROOT,
      appEnv: "dev" as const,
      tenantName: "permission-4b",
      ownerEmail: "owner@example.invalid",
      companyCode: "HQ",
      companyName: "permission-4b HQ",
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

describe("migration 0052 — accounting.bank.reconcile, its grant and the six consumed accounts (contracts §3.6.2, §3.6.4, §4.15)", () => {
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "permission-4b");
    // The accounts are NOT created by this test. 0C's chart-of-accounts loader applies the real pack for this
    // tenant exactly as it would in staging, so the resolution case below proves the PACK provides every code
    // this slice resolves — 4B itself re-seeds none (hazard 33). The loader is idempotent on
    // (company_id, code) (contracts §3.4.8), so the 5920 row seedTenantV2 wired to the company stands.
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, loaderContext()),
    );
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  it("applies as version 52", async () => {
    expect(await listApplied(db.migrator)).toContain(52);
  });

  it("app.permission carries the one 4B row, module accounting and mutating", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission where code = ${CODE}`;
    expect(rows).toEqual([{ code: CODE, module: "accounting", mutating: true }]);
  });

  it("accountant holds it; auditor does not, because it is mutating (R7, spec:2157, 2163)", () => {
    expect(of("accountant")).toContain(CODE);
    expect(of("auditor")).not.toContain(CODE);
    expect(of("user")).not.toContain(CODE);
    expect(of("warehouse")).not.toContain(CODE);
    // Exactly the one role §3.6.4 records for it; admin's array is computed from the catalogue, never edited.
    expect(holders(CODE)).toEqual(["accountant"]);
    expect(of("admin")).toEqual([]);
  });

  it("no seeded role other than admin holds an incompatible pair (R6, spec:2177)", () => {
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin")) {
      for (const [left, right] of INCOMPATIBLE_PAIRS) {
        expect(
          role.permissions.includes(left) && role.permissions.includes(right),
          `${role.code} holds both ${left} and ${right}`,
        ).toBe(false);
      }
    }
  });

  // ── Hazard 33's real assertion: it reads 0C's SHIPPED PACK, not a row this test made ───────────────────
  it("0C's shipped chart pack declares all six codes this slice consumes, with the §4.15 types", () => {
    // `readPackFile` (§4.2.13, 0C) throws SeedError naming the file when it is absent or malformed, so a
    // moved pack is a named failure rather than an empty array.
    const rows = readPackFile<{ code: string; nameEn: string; type: string; isGroup?: boolean }[]>(
      PACK_ROOT,
      "chart-of-accounts",
      "0c-base.json",
    );
    const leaves = new Map(
      rows.filter((row) => row.isGroup !== true).map((row) => [row.code, row]),
    );
    for (const account of CONSUMED_ACCOUNTS) {
      const leaf = leaves.get(account.code);
      expect(
        leaf,
        `0c-base.json has no leaf ${account.code} — 0C dropped a §4.15 row`,
      ).toBeDefined();
      expect(leaf!.type, account.code).toBe(account.type);
      expect(leaf!.nameEn, account.code).toBe(account.nameEn);
      expect(account.code[0], account.code).toBe(FIRST_DIGIT[account.type]);
    }
    // ⚠️ 1150 Cheques in hand is Task 9's 4b-pdc.json, only if OD-09 — never 0C's base file.
    expect(rows.some((row) => row.code === "1150")).toBe(false);
  });

  it("every account code this slice resolves exists for the seeded company, with the right type (hazard 33)", async () => {
    const codes = CONSUMED_ACCOUNTS.map((account) => account.code);
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; name_en: string; t: string }[]>`
        select code, name_en, type::text as t from app.account
         where company_id = ${s.company} and code = any(${codes}) and archived_at is null
         order by code`,
    );
    expect(rows.map((row) => row.code)).toEqual(["1100", "1200", "2100", "4900", "5910", "5920"]);
    for (const account of CONSUMED_ACCOUNTS) {
      const row = rows.find((candidate) => candidate.code === account.code)!;
      expect(row.t, account.code).toBe(account.type);
      expect(row.name_en, account.code).toBe(account.nameEn);
    }
  });

  it("this slice seeds no chart-of-accounts file of its own in the unconditional path (§4.15)", () => {
    // 4b-pdc.json may appear ONLY when OD-09 lands (Task 9). No other 4b file may ever appear.
    const mine = readdirSync(CHART_DIR).filter((file) => /^4b/i.test(file));
    expect(mine.filter((file) => file !== "4b-pdc.json")).toEqual([]);
  });

  it("lintSchema reports zero violations after 0052", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
