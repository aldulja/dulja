import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocumentTypeSeed, validatePolicy } from "@dulja/domain";
import { seedTenantV2, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";
import { runLoaders } from "../../src/seed";

// The repository root, computed locally. There is deliberately NO `packages/db/test/support/repo.ts`:
// §4.17.1 puts `REPO_ROOT` in `tests/support/source.ts` (0B) and `packages/db` may not import the `tests`
// workspace (§3.1), so a shared helper here would be either a dependency-rule violation or a new
// registered name this slice has no row for (hazard 9). 0C's own provisioning test computes it the same
// way (0c:415), and three lines in two files is cheaper than a fourth register entry.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const PACK = join(REPO_ROOT, "packages/db/seed/my");

/**
 * The permission catalogue `validatePolicy` checks `approval.post` against — read from **`app.permission`
 * rows**, never from an import of `PERMISSIONS`.
 *
 * §3.1's dependency rule pins `packages/db` to `@dulja/domain`, and `scripts/lint/rules/dependency-rule.ts`
 * runs over every import under `packages/**` — test files included, which is why `no-bare-db` has to
 * name `packages/db/test/**` on an allow-list at all (§3.7.5). `import { PERMISSIONS } from
 * "@dulja/contracts/permissions"` here is therefore a `dependency-rule` violation and Task 13 Step 4
 * requires `bun run lint:rules` green. **3B met this exact need and solved it this exact way** (3b:3435,
 * citing 1a:5105): *"the permission catalogue **as rows of `app.permission`, not as an import of
 * `PERMISSIONS`** — `dependency-rule` forbids `packages/db` naming `@dulja/contracts`"*. `app.permission`
 * is global and un-RLS'd (plan0A:1254), so `db.admin` reads it with no tenant context.
 */
async function loadPack(
  db: Db,
  s: Seed,
  pack: "chart-of-accounts" | "document-types",
): Promise<void> {
  await runLoaders(
    db.rw,
    {
      config: { tenantId: s.tenant } as never,
      tenantId: s.tenant,
      companyId: s.company,
      systemPrincipalId: s.system,
      packRoot: PACK,
    },
    [pack],
    "till-pack",
  );
}
let catalogue: string[];

describe("6D seed pack — 6d-till.json and TILL_OVER_SHORT.json (§4.14, §4.15)", () => {
  let db: Db;
  let s: Seed;
  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "TillPack");
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (r) => r.code,
    );
  }, 240_000);
  afterAll(async () => {
    await db.stop();
  });

  it("6d-till.json holds §4.15's two unconditional rows and OD-10's 5130, in the frozen shape", () => {
    const rows = JSON.parse(readFileSync(join(PACK, "chart-of-accounts/6d-till.json"), "utf8")) as {
      code: string;
      nameEn: string;
      nameAr: string;
      type: string;
    }[];
    expect(rows.map((r) => r.code).toSorted()).toEqual(["1130", "5120", "5130"]);
    // The code format rule of §4.15: four digits, first digit === the account_type's enum position.
    for (const r of rows) {
      expect(r.code).toMatch(/^[1-5][0-9]{3}$/);
      expect(r.code[0]).toBe(
        { asset: "1", liability: "2", equity: "3", income: "4", expense: "5" }[r.type],
      );
      expect(r.nameAr.length).toBeGreaterThan(0);
    }
    // 6A's three tender accounts are NOT here — 6A seeds them (hazard 33) and two files must not collide.
    const text = readFileSync(join(PACK, "chart-of-accounts/6d-till.json"), "utf8");
    for (const foreign of ["1110", "1120", "2200", "1100"]) expect(text).not.toContain(foreign);
  });

  it("TILL_OVER_SHORT.json is a valid §4.3.7 envelope whose policy validates against the catalogue", () => {
    const env = JSON.parse(readFileSync(join(PACK, "document-types/TILL_OVER_SHORT.json"), "utf8"));
    expect(validateDocumentTypeSeed(env)).toEqual({ ok: true, errors: [] });
    expect(validatePolicy(env.policy, catalogue)).toEqual({ ok: true, errors: [] });
    expect(env.module).toBe("pos"); // §4.14's Module column — the §4.5.8 gate
    expect(env.policy.numbering.series).toBe("TOS"); // the POLICY series; resolveSeries suffixes it (A15)
    expect(env.policy.approval.post).toBe("pos.sync.push");
    expect(env.policy.inventory.effect).toBe("none");
    expect(env.policy.tax.applies).toBe(false);
    expect(env.policy.dimensions.required).toEqual(["BRANCH"]);
  });

  it("OD-10's three till cash types are valid envelopes in TILL_OVER_SHORT's shape (ADR 0064)", () => {
    const expected = {
      TILL_PAID_OUT: { series: "TPO", direction: "outbound" },
      TILL_SAFE_DROP: { series: "TSD", direction: "internal" },
      TILL_BANKING: { series: "TBK", direction: "internal" },
    } as const;
    for (const [code, want] of Object.entries(expected)) {
      const text = readFileSync(join(PACK, `document-types/${code}.json`), "utf8");
      const env = JSON.parse(text);
      expect(validateDocumentTypeSeed(env), code).toEqual({ ok: true, errors: [] });
      expect(validatePolicy(env.policy, catalogue), code).toEqual({ ok: true, errors: [] });
      expect(env.module).toBe("pos");
      expect(env.policy.numbering.series).toBe(want.series);
      expect(env.policy.direction).toBe(want.direction);
      expect(env.policy.requires).toEqual(["client_ref", "attributed_to"]); // the till's ref is the dedup key
      expect(env.policy.approval.post).toBe("pos.sync.push");
      expect(env.policy.reversal.producesType).toBe(code);
      expect(env.policy.dimensions.required).toEqual(["BRANCH"]);
      // `applyCashEvent` picks the pair of accounts; the policy names none (hazard 33).
      expect(text).not.toMatch(/"code"\s*:\s*"[1-5][0-9]{3}"/);
    }
  });

  it("the policy names NO account by code — every leg resolves from the line (hazard 33)", () => {
    const text = readFileSync(join(PACK, "document-types/TILL_OVER_SHORT.json"), "utf8");
    expect(text).not.toMatch(/"code"\s*:\s*"[1-5][0-9]{3}"/);
    const env = JSON.parse(text);
    for (const rule of env.policy.lines) {
      if (rule.account?.from === "company.fx_rounding_account_id") continue;
      expect(rule.account).toEqual({ from: "line.account" });
    }
  });

  it("applying the pack creates both accounts, and every code the till path resolves is present", async () => {
    // The whole chart sub-pack, in the order §3.4.8 fixes: 0C's base, then 6A's tenders, then 6D's.
    await loadPack(db, s, "chart-of-accounts");
    await loadPack(db, s, "document-types");

    // `a.type`, NOT `a.account_type`. `app.account_type` is the ENUM TYPE's name (plan0A:1484); the COLUMN
    // is `type app.account_type not null` (plan0A:1492), and §3.2 forbids renames, so no migration adds a
    // second spelling. Every other written plan uses `type` (1b:2779, 4b:2169, 5a:4676).
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; type: string }[]>`
      select code, type::text as type from app.account
       where company_id = ${s.company} and code in ('1100','1110','1120','1130','2200','5120')
       order by code`,
    );
    expect(rows.map((r) => r.code)).toEqual(["1100", "1110", "1120", "1130", "2200", "5120"]);
    expect(rows.find((r) => r.code === "1130")!.type).toBe("asset");
    expect(rows.find((r) => r.code === "5120")!.type).toBe("expense");
  });

  it("re-applying the pack is idempotent on (company_id, code) and on (document_type_id, version)", async () => {
    await loadPack(db, s, "chart-of-accounts");
    await loadPack(db, s, "document-types");
    const [n] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.account where company_id = ${s.company} and code = '5120'`,
    );
    expect(n!.n).toBe(1);
    const [p] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.posting_policy pp
        join app.document_type dt on dt.id = pp.document_type_id
       where dt.code = 'TILL_OVER_SHORT' and dt.company_id = ${s.company}`,
    );
    expect(p!.n).toBe(1);
  });
});
