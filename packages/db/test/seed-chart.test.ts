import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { seed, SeedError } from "../src/seed";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { parseSeedArgs } from "../src/seed/config";
import { seedTenant } from "./fixtures";
import { startDb, type Db } from "./harness";

const ZERO_C_LEAVES = [
  "1000",
  "1100",
  "1200",
  "1300",
  "2100",
  "4000",
  "4900",
  "5000",
  "5900",
  "5910",
  "5920",
];

/** 3C Task 3 — the three rows §4.15 assigns this slice, in `chart-of-accounts/3c-purchasing.json`.
 *  §4.15 splits the chart one file per slice, so this list grows with every chart-adding slice
 *  (3D adds `1250` and `5110`); the seed applies every `.json` in the sub-pack, not 0C's alone. */
const THREE_C_LEAVES = ["1310", "2150", "5100"];

/** 3D Task 2 — the two rows §4.15 assigns this slice, in `chart-of-accounts/3d-adjustments.json`.
 *  `1250` hangs off 0C's `1200` and `5110` off 3C's `5100`, so both are second-level leaves and neither
 *  moves the `direct` assertion below. */
const THREE_D_LEAVES = ["1250", "5110"];

/** 8B Task 4 — the eleven §4.15 payroll leaves in `chart-of-accounts/8b-payroll.json`. The four statutory payables
 *  hang off 8B's own `2410` group (a second group parent, unregistered by §4.15); the other seven hang directly off
 *  0C's type groups. */
const EIGHT_B_DIRECT = ["1400", "2400", "5300", "5311", "5312", "5313", "5314"];
const EIGHT_B_LEAVES = [...EIGHT_B_DIRECT, "2411", "2412", "2413", "2414"];

/** 9B Task 4 — `3900` Opening-balance suspense in `chart-of-accounts/9b-cut-over.json`, the balancing leg of both
 *  cut-over document types (§4.15, round 20 C11), directly under 0C's equity group `3`. */
const NINE_B_LEAVES = ["3900"];

const ALL_LEAVES = [
  ...ZERO_C_LEAVES,
  ...THREE_C_LEAVES,
  ...THREE_D_LEAVES,
  "1350",
  "2300",
  "1110",
  "1120",
  "1130",
  "2200",
  "5120",
  // OD-10 (answered yes, 2026-11-04): 6D's Till paid out, under the expense group like 5120.
  "5130",
  ...EIGHT_B_LEAVES,
  ...NINE_B_LEAVES,
].toSorted();

describe("the chart-of-accounts loader — §4.15's eleven 0C leaves and the FX-rounding link (spec:2001)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  let companyId = "";
  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
    ({ companyId } = await seed(
      migrator,
      parseSeedArgs(["--tenant", tenantId], {} as NodeJS.ProcessEnv),
      new StubSeedAuthAdmin(),
    ));
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  it("seeds exactly the registered leaves of every slice, and every group parent is is_group", async () => {
    const rows = await db.admin<{ code: string; is_group: boolean; type: string }[]>`
      select code, is_group, type::text from app.account where company_id = ${companyId} order by code`;
    expect(rows.filter((r) => !r.is_group).map((r) => r.code)).toEqual(ALL_LEAVES);
    expect(rows.filter((r) => r.is_group).map((r) => r.code)).toEqual([
      "1",
      "2",
      "2410",
      "3",
      "4",
      "5",
    ]);
  });

  it("the first digit is the account_type in the enum's own order (§4.15's format rule)", async () => {
    const digit: Record<string, string> = {
      asset: "1",
      liability: "2",
      equity: "3",
      income: "4",
      expense: "5",
    };
    const rows = await db.admin<{ code: string; type: string }[]>`
      select code, type::text from app.account where company_id = ${companyId}`;
    for (const r of rows) expect(r.code[0], r.code).toBe(digit[r.type]);
  });

  it("every leaf hangs off a parent inside its own type tree, through the composite FK", async () => {
    // 0C's eleven leaves each hang off the one-digit group. 3C introduced the chart's second level —
    // `2150` under `2100`, `1310` under `1300`, `5100` under `5000` — so the invariant this case exists
    // for is no longer "the parent IS the group digit" but "the parent is in the same type tree", which
    // is what the composite FK plus the first-digit rule together guarantee.
    const rows = await db.admin<{ code: string; parent_code: string | null }[]>`
      select a.code, p.code as parent_code from app.account a left join app.account p on p.id = a.parent_id
       where a.company_id = ${companyId} and a.is_group = false order by a.code`;
    for (const r of rows) {
      expect(r.parent_code, r.code).not.toBeNull();
      expect(r.parent_code![0], r.code).toBe(r.code[0]);
    }
    const direct = rows.filter((r) => r.parent_code!.length === 1).map((r) => r.code);
    expect(direct).toEqual(
      [
        ...ZERO_C_LEAVES,
        "1350",
        "2300",
        "1110",
        "1120",
        "1130",
        "2200",
        "5120",
        "5130",
        ...EIGHT_B_DIRECT,
        ...NINE_B_LEAVES,
      ].toSorted(),
    );
  });

  it("company.fx_rounding_account_id points at 5920 immediately after insertion (spec:2001)", async () => {
    const [row] = await db.admin<{ code: string }[]>`
      select a.code from app.company c join app.account a on a.id = c.fx_rounding_account_id where c.id = ${companyId}`;
    expect(row!.code).toBe("5920");
  });

  it("bilingual labels are columns, never a blob (spec:2045)", async () => {
    const [row] = await db.admin<{ name_en: string; name_ar: string }[]>`
      select name_en, name_ar from app.account where company_id = ${companyId} and code = '5920'`;
    expect(row!.name_en).toBe("FX rounding");
    expect(row!.name_ar.length).toBeGreaterThan(0);
  });

  it("re-running inserts nothing and writes no audit row — the fx link update is `is distinct from`-guarded", async () => {
    const [before] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    const again = await seed(
      migrator,
      parseSeedArgs(["--tenant", tenantId, "--only", "chart-of-accounts"], {} as NodeJS.ProcessEnv),
      new StubSeedAuthAdmin(),
    );
    expect(again.applied["chart-of-accounts"]).toBe(0);
    const [after] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    expect(after!.n).toBe(before!.n);
  });

  it("the pack does not collide with Plan 0A's fixture accounts 1000 Cash and 4000 Sales (§4.15)", async () => {
    // `seedTenant` creates its company with code 'HQ' and `parseSeedArgs` defaults `companyCode` to "HQ", so
    // `bootstrapCompany`'s `on conflict (tenant_id, code) do nothing` adopts the fixture's own company row and the
    // loader writes into it. The collision is real, not avoided by writing into a second company.
    const s = await seedTenant(db, "Fixture");
    const before = await db.admin<{ id: string; code: string; name_en: string }[]>`
      select id::text as id, code, name_en from app.account
       where company_id = ${s.company} and code in ('1000', '4000') order by code`;
    expect(before.map((r) => r.id).toSorted()).toEqual([s.cash, s.sales].toSorted());

    const cfg = parseSeedArgs(
      ["--tenant", s.tenant, "--only", "chart-of-accounts"],
      {} as NodeJS.ProcessEnv,
    );
    const result = await seed(migrator, cfg, new StubSeedAuthAdmin());
    expect(result.companyId).toBe(s.company); // the loader targeted the fixture's company, not a new one

    const after = await db.admin<{ id: string; code: string; name_en: string }[]>`
      select id::text as id, code, name_en from app.account
       where company_id = ${s.company} and code in ('1000', '4000') order by code`;
    expect(after).toHaveLength(2); // one each — no duplicate row
    expect(after).toEqual(before); // adopted, not overwritten: same ids, and 'Cash'/'Sales' intact
  });

  it("a code that breaks the format is rejected by name, not silently loaded (ERR_VALIDATION_FAILED)", async () => {
    const root = mkdtempSync(join(tmpdir(), "dulja-bad-"));
    for (const d of ["chart-of-accounts", "dimensions", "fiscal-periods"])
      mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "dimensions", "branch.json"), "[]");
    writeFileSync(
      join(root, "fiscal-periods", "monthly.json"),
      '{"periodsPerYear":12,"status":"open"}',
    );
    writeFileSync(
      join(root, "chart-of-accounts", "0c-base.json"),
      '[{"code":"9999","nameEn":"Bad","nameAr":"سيئ","type":"expense"}]',
    );
    // Its own owner: since DBS-12 an owner already seeded into another tenant of this database is refused
    // before any loader runs, and this case is about the pack.
    const cfg = parseSeedArgs(
      ["--tenant", randomUUID(), "--pack", root, "--owner-email", "bad-pack@example.my"],
      {} as NodeJS.ProcessEnv,
    );
    await expect(seed(migrator, cfg, new StubSeedAuthAdmin())).rejects.toThrow(SeedError);
    await expect(seed(migrator, cfg, new StubSeedAuthAdmin())).rejects.toThrow(
      /chart-of-accounts\/0c-base\.json: account code '9999' does not match \^\[1-5\]\[0-9\]\{3\}\$ with first digit 5 for type expense/,
    );
  });
});
