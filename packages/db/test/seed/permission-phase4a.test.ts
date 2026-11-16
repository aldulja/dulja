import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chartOfAccountsLoader } from "../../src/seed/chart-of-accounts";
import { INCOMPATIBLE_PAIRS, ROLES } from "../../seed/roles";
import { grantCodes, seedTenantV2, startDb, withTenant, type Db, type Seed } from "../index";
import { secondPrincipal } from "../../../../tests/invariants/support/post-inventory";

const here = dirname(fileURLToPath(import.meta.url));
const PACK_ROOT = join(here, "..", "..", "seed", "my");
const CHART_DIR = join(PACK_ROOT, "chart-of-accounts");

/** The seven codes contracts §3.6.2 assigns 4A, in the order `order by code` returns them. The catalogue
 *  half — that packages/contracts/permissions.ts carries the same seven, each `phase: "4A"` — is asserted in
 *  packages/db/test/permission-catalogue.test.ts: 0B's `dependency-rule` lets exactly that one file in this
 *  workspace import @dulja/contracts. */
const CODES = [
  "accounting.credit_limit.override",
  "accounting.payment.approve",
  "accounting.payment.create",
  "accounting.payment.post",
  "accounting.receipt.create",
  "accounting.receipt.post",
  "accounting.sales.post",
] as const;

/**
 * The EIGHT §4.15 codes this slice's six policies resolve, with the slice that seeds each. 4A seeds none.
 * It is the plan header's list verbatim, and the three entries a reader will ask about are stated here so
 * the lists cannot drift apart again:
 *
 *  • `5920` IS on the list. Every one of the six policies carries
 *    `"fxRoundingAccount": { "from": "company.fx_rounding_account_id" }`, which resolves it on every post
 *    (§4.15), so it is the account `balanceInBase` needs most often and the one whose absence would be
 *    discovered at the first foreign-currency post rather than here.
 *  • `1300` is NOT on the list. No 4A policy names it — it is 3C's `GOODS_RECEIPT` inventory leg, and
 *    Task 7's suite asserts the purchase invoice leaves it UNTOUCHED. Asserting it here would claim a
 *    consumption this slice does not have.
 *  • `4000` is not on the list either: `SALES_INVOICE` and `SALES_CREDIT_NOTE` resolve it through
 *    `item.revenue_account`, not by a policy code, and `seedTenantV2` creates `4000 Sales` for every seeded
 *    company (§4.1). Its resolution is asserted where it is used — Task 5's four-row ledger case.
 */
const CONSUMED_ACCOUNTS = [
  ["1100", "asset", "0C"],
  ["1200", "asset", "0C"],
  ["1250", "asset", "3D"],
  ["2100", "liability", "0C"],
  ["2150", "liability", "3C"],
  ["5000", "expense", "0C"],
  ["5900", "expense", "0C"],
  ["5920", "expense", "0C"],
] as const;

/**
 * The accounting codes that have SHIPPED once this slice lands — nineteen, in the order §3.6.2 lists them:
 * 1A's six, 1B's one, 2A's one, 2B's one, 3C's two, 3D's one and this slice's seven. §3.6.2's "accounting 23"
 * is the complete v1 catalogue, and its other four codes belong to slices after this one (`LATER_ACCOUNTING`):
 * test 14's re-run asserts the nineteen are all present and that nothing else is, save one of those four —
 * so it neither goes red when 4B's `bank.reconcile` merges first nor passes over an unregistered code.
 */
const SHIPPED_ACCOUNTING = [
  "accounting.account.manage",
  "accounting.ledger.read",
  "accounting.period.close",
  "accounting.period.reopen",
  "accounting.journal.create",
  "accounting.journal.post",
  "accounting.report.read",
  "accounting.party.manage",
  "accounting.document.reverse",
  "accounting.purchase.create",
  "accounting.purchase.post",
  "accounting.sales.create",
  ...CODES,
] as const;
const LATER_ACCOUNTING = [
  "accounting.bank.reconcile",
  "accounting.tax.manage",
  "accounting.tax.file",
  "accounting.report.export",
] as const;

/** The chart file each seeding slice ships (§4.15's register; 0C's is `0c-base.json`). */
const CHART_FILE: Record<(typeof CONSUMED_ACCOUNTS)[number][2], string> = {
  "0C": "0c-base.json",
  "3C": "3c-purchasing.json",
  "3D": "3d-adjustments.json",
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

/** The codes one chart file declares. */
function chartCodes(file: string): string[] {
  return (JSON.parse(readFileSync(join(CHART_DIR, file), "utf8")) as { code: string }[]).map(
    (row) => row.code,
  );
}

/** The `only` member is the CLI's `--only chart-of-accounts`; every other member is a fixture value. */
function loaderContext() {
  return {
    config: {
      tenantId: s.tenant,
      only: ["chart-of-accounts"] as const,
      packRoot: PACK_ROOT,
      appEnv: "dev" as const,
      tenantName: "permission-4a",
      ownerEmail: "owner@example.invalid",
      companyCode: "HQ",
      companyName: "permission-4a HQ",
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

describe("slice 4A's catalogue, its role grants and the accounts it consumes (contracts §3.6.2, §3.6.4, §4.15)", () => {
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "permission-4a");
    // The accounts are NOT created by this test. 0C's chart-of-accounts loader applies the real pack for
    // this tenant, so 0C's, 3C's and 3D's files land exactly as they would in staging, and the resolution
    // case below proves the pack provides every code 4A's policies name — 4A itself re-seeds none. The
    // loader is idempotent on (company_id, code) (contracts §3.4.8), so seedTenantV2's 1000/4000/5920 stand.
    await withTenant(db.migrator, s.tenant, s.system, (tx) =>
      chartOfAccountsLoader.load(tx, loaderContext()),
    );
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });

  it("migration 0047 seeded exactly the seven codes, module accounting and mutating true", async () => {
    const rows = await db.admin<{ code: string; module: string; mutating: boolean }[]>`
      select code, module, mutating from app.permission
       where code = 'accounting.sales.post'
          or code like 'accounting.receipt.%'
          or code like 'accounting.payment.%'
          or code = 'accounting.credit_limit.override'
       order by code`;
    expect(rows.map((row) => row.code)).toEqual([...CODES]);
    expect(rows.every((row) => row.module === "accounting" && row.mutating)).toBe(true);
  });

  it("accountant holds six of the seven and NOT accounting.payment.create (R6, spec:2157)", () => {
    expect(of("accountant")).toContain("accounting.sales.post");
    expect(of("accountant")).toContain("accounting.receipt.create");
    expect(of("accountant")).toContain("accounting.receipt.post");
    expect(of("accountant")).toContain("accounting.payment.approve");
    expect(of("accountant")).toContain("accounting.payment.post");
    expect(of("accountant")).toContain("accounting.credit_limit.override");
    expect(of("accountant")).not.toContain("accounting.payment.create");
  });

  it("user drafts both and posts neither, and cannot override a credit limit (spec:2158)", () => {
    expect(of("user")).toEqual(
      expect.arrayContaining(["accounting.receipt.create", "accounting.payment.create"]),
    );
    expect(of("user")).not.toContain("accounting.receipt.post");
    expect(of("user")).not.toContain("accounting.payment.approve");
    expect(of("user")).not.toContain("accounting.payment.post");
    expect(of("user")).not.toContain("accounting.sales.post");
    expect(of("user")).not.toContain("accounting.credit_limit.override");
  });

  it("each 4A code is held by exactly the roles §3.6.4 records, and the auditor holds none (R7)", () => {
    expect(holders("accounting.sales.post")).toEqual(["accountant"]);
    expect(holders("accounting.receipt.create")).toEqual(["accountant", "user"]);
    expect(holders("accounting.receipt.post")).toEqual(["accountant"]);
    expect(holders("accounting.payment.create")).toEqual(["user"]);
    expect(holders("accounting.payment.approve")).toEqual(["accountant"]);
    expect(holders("accounting.payment.post")).toEqual(["accountant"]);
    expect(holders("accounting.credit_limit.override")).toEqual(["accountant"]);
    expect(of("auditor").filter((code) => (CODES as readonly string[]).includes(code))).toEqual([]);
    // admin's array is computed from the catalogue and never edited (§3.6.4).
    expect(of("admin")).toEqual([]);
  });

  it("R6's payment pair is now live — both codes exist — and no seeded non-admin role holds both", () => {
    const pair = INCOMPATIBLE_PAIRS.find(([left]) => left === "accounting.payment.create");
    expect(pair).toEqual(["accounting.payment.create", "accounting.payment.approve"]);
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin")) {
      for (const [left, right] of INCOMPATIBLE_PAIRS) {
        expect(
          role.permissions.includes(left) && role.permissions.includes(right),
          `${role.code} holds both ${left} and ${right}`,
        ).toBe(false);
      }
    }
  });

  it("all EIGHT accounts this slice's policies name resolve for the seeded company, by code (hazard 33)", async () => {
    const codes = CONSUMED_ACCOUNTS.map(([code]) => code);
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; t: string }[]>`
        select code, type::text as t from app.account
         where company_id = ${s.company} and code = any(${codes}) and archived_at is null
         order by code`,
    );
    expect(rows.map((row) => row.code)).toEqual(codes);
    // The first digit IS the account type, in the enum's own order (§4.15's frozen code format).
    for (const [code, type] of CONSUMED_ACCOUNTS) {
      expect(rows.find((row) => row.code === code)!.t, code).toBe(type);
    }
  });

  it("TEST 14 — 'who can post a purchase return in company X' is ONE query, over the full catalogue (spec:2432)", async () => {
    // The question names a real type: PURCHASE_RETURN is configuration (3C), and its seeded policy posts
    // under `accounting.purchase.post` — the code the query is asked about (§3.6.2's closing paragraph).
    const purchaseReturn = JSON.parse(
      readFileSync(join(PACK_ROOT, "document-types", "PURCHASE_RETURN.json"), "utf8"),
    ) as { policy: { approval: { post: string } } };
    expect(purchaseReturn.policy.approval.post).toBe("accounting.purchase.post");

    // Two principals holding the SEEDED grants of `accountant` and `user` (roles.ts), through real role →
    // role_permission → role_assignment rows, so the answer is a fact about the seeded catalogue rather than
    // a fixture the test chose. `seedTenant` grants s.human nothing (§4.1), so these two are everyone.
    const accountant = await secondPrincipal(db, s, "t14-accountant");
    const clerk = await secondPrincipal(db, s, "t14-user");
    await grantCodes(db, s, {
      codes: of("accountant"),
      principalId: accountant,
      roleCode: "t14-accountant",
    });
    await grantCodes(db, s, { codes: of("user"), principalId: clerk, roleCode: "t14-user" });

    const who = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ principalId: string }[]>`
        select distinct ra.principal_id::text as "principalId"
          from app.role_assignment ra
          join app.role_permission rp on rp.role_id = ra.role_id
         where ra.company_id = ${s.company}
           and rp.permission_code = 'accounting.purchase.post'
           and (ra.expires_at is null or ra.expires_at > now())`,
    );
    // The accountant posts purchases; the clerk only drafts them (spec:2158).
    expect(who.map((row) => row.principalId)).toEqual([accountant]);

    // The SAME join, unfiltered by code, answers every accounting code in one statement — which is what
    // "over the full catalogue" means, and it must agree with roles.ts code by code. This is spec:2432, and
    // exactly what SAH-034/047 made impossible.
    const answers = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; principals: string[] }[]>`
        select p.code,
               coalesce(array_agg(distinct ra.principal_id::text)
                          filter (where ra.principal_id is not null), '{}') as principals
          from app.permission p
          left join app.role_permission rp on rp.permission_code = p.code
          left join app.role_assignment ra
                 on ra.role_id = rp.role_id and ra.company_id = ${s.company}
                and (ra.expires_at is null or ra.expires_at > now())
         where p.module = 'accounting'
         group by p.code
         order by p.code`,
    );
    const codes = answers.map((row) => row.code);
    expect(codes).toEqual(expect.arrayContaining([...SHIPPED_ACCOUNTING]));
    expect(
      codes.filter(
        (code) =>
          !(SHIPPED_ACCOUNTING as readonly string[]).includes(code) &&
          !(LATER_ACCOUNTING as readonly string[]).includes(code),
      ),
    ).toEqual([]);
    for (const { code, principals } of answers) {
      const expected = [
        ...(of("accountant").includes(code) ? [accountant] : []),
        ...(of("user").includes(code) ? [clerk] : []),
      ].toSorted();
      expect(principals.toSorted(), code).toEqual(expected);
    }
  });

  it("slice 4A ships NO chart-of-accounts file — every code it names is seeded by its registered slice (§4.15)", () => {
    const files = readdirSync(CHART_DIR);
    expect(files.filter((file) => /^4a/i.test(file))).toEqual([]);
    // and the corridor accounts are exactly where the register says they are
    for (const [code, , slice] of CONSUMED_ACCOUNTS) {
      expect(files, `${slice}'s chart file`).toContain(CHART_FILE[slice]);
      expect(chartCodes(CHART_FILE[slice]), `${code} is ${slice}'s`).toContain(code);
    }
  });
});
