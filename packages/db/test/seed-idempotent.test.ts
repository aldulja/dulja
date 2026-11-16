import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { seed } from "../src/seed";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { parseSeedArgs } from "../src/seed/config";
import { startDb, type Db } from "./harness";

/** Every `<slice>/<code>.json` under the shipped `reports` sub-pack — the rows a first seed run inserts. */
function shippedReportDefinitions(): number {
  const root = fileURLToPath(new URL("../seed/my/reports", import.meta.url));
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .reduce(
      (n, e) => n + readdirSync(join(root, e.name)).filter((f) => f.endsWith(".json")).length,
      0,
    );
}

/** Every table the seed writes, plus the two that would betray a silent re-write. */
const TOUCHED = [
  "app.tenant",
  "app.principal",
  "app.membership",
  "app.company",
  "app.role",
  "app.role_permission",
  "app.role_assignment",
  "app.dimension_type",
  "app.dimension_value",
  "app.fiscal_period",
  "app.account",
  "app.audit_log",
  "pgboss.tenant_registry",
] as const;

describe("§5.0 row 0.7b — running it twice changes nothing (spec:2317)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  const auth = new StubSeedAuthAdmin();
  const cfg = () =>
    parseSeedArgs(
      ["--tenant", tenantId, "--owner-email", "owner@example.my", "--fiscal-year", "2026"],
      {} as NodeJS.ProcessEnv,
    );

  /** Table names are escaped identifiers from the frozen list above (postgres.js's own `sql(name)` helper). */
  const census = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of TOUCHED) {
      const [row] = await db.admin<
        { n: number }[]
      >`select count(*)::int as n from ${db.admin(table)}`;
      out[table] = row!.n;
    }
    return out;
  };

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  it("the first run creates the tenant and reports what it applied", async () => {
    const r = await seed(migrator, cfg(), auth);
    expect(r.created).toBe(true);
    expect(r.tenantId).toBe(tenantId);
    expect(r.companyId).not.toBe("");
    expect(r.ownerPrincipalId).not.toBe("");
    expect(r.applied["fiscal-periods"]).toBe(12);
    // 0C's eleven leaves + five group parents + 3C Task 3's three (2150, 1310, 5100) + 3D Task 2's two
    // (1250, 5110), plus Phase 5's 1350 and 2300. §4.15 is one chart file per slice and the loader applies every `.json` in the
    // sub-pack, so this number grows with every slice that seeds an account.
    // 6A adds three tender accounts; 6D adds 1130 and 5120, and 5130 for OD-10 (answered yes 2026-11-04).
    // 8B adds its eleven payroll leaves and the 2410 statutory-payable group (8b-payroll.json) — 41.
    // 9B Task 4 adds 3900 Opening-balance suspense (9b-cut-over.json) — 42.
    expect(r.applied["chart-of-accounts"]).toBe(42);
    // JOURNAL + 3B T8's COST_ADJUSTMENT + 3C T5's PURCHASE_ORDER + 3C T6's GOODS_RECEIPT + 3C T9's
    // SHIPMENT + 3C T10's PURCHASE_RETURN + 3D T5's SALES_ORDER + 3D T6's DELIVERY_ORDER + 3D T7's
    // TRANSFER + 3D T8's TRANSFER_RECEIPT and STOCK_COUNT + 3D T9's EXPIRY_WRITE_OFF + 4A T5's
    // SALES_INVOICE + 4A T7's PURCHASE_INVOICE + 4A T8's SALES_CREDIT_NOTE and PURCHASE_CREDIT_NOTE + 4A
    // T10's RECEIPT and PAYMENT + 4B T5's FX_REVALUATION, one company. §3.4.8 is one file per document type
    // and the loader applies every `.json` in the sub-pack, so this number grows with every slice that seeds
    // one.
    // 6A adds POS_TICKET; 6D adds TILL_OVER_SHORT and OD-10's TILL_PAID_OUT, TILL_SAFE_DROP and TILL_BANKING.
    // 8B adds PAYROLL — 25. 8C T5 adds PAYROLL_PAYMENT and EMPLOYEE_ADVANCE — 27.
    // 9B Task 5 adds OPENING_BALANCE (series OB, the cut-over trial-balance opening) — 28. 9B Task 6 adds
    // OPENING_STOCK (series OS, the opening stock at a recomputed cost) — 29.
    expect(r.applied["document-types"]).toBe(29);
    expect(r.applied.dimensions).toBe(2); // BRANCH + head office
    expect(r.applied.roles).toBeGreaterThan(0);
    expect(r.applied.tax).toBe(5);
    // 7A ships the loader and seeds no definition (§2.8); the catalogue slices' files (7B's `7b/`, later 7C's
    // and 8D's) are what a first run inserts, one row per shipped file (contracts 7B amendment A18 item 4).
    expect(r.applied.reports).toBe(shippedReportDefinitions());
    // 8A: four scheme names and six pay components, and no rate table — OD-23 has not supplied one (spec:2080).
    expect(r.applied.statutory).toBe(10);
  });

  it("the second run inserts nothing anywhere — including app.audit_log", async () => {
    const before = await census();
    const r = await seed(migrator, cfg(), auth);
    expect(r.created).toBe(false);
    // Nine sub-packs after Phase 5 adds tax, 7A reports and 8A statutory; every one of them inserts nothing.
    expect(r.applied).toEqual({
      roles: 0,
      dimensions: 0,
      "fiscal-periods": 0,
      "chart-of-accounts": 0,
      "document-types": 0,
      templates: 0,
      tax: 0,
      reports: 0,
      statutory: 0,
    });
    expect(await census()).toEqual(before);
  });

  it("a third run under --only re-applies one pack and still changes nothing", async () => {
    const before = await census();
    for (const pack of [
      "roles",
      "dimensions",
      "fiscal-periods",
      "chart-of-accounts",
      "document-types",
      "templates",
      "tax",
      "reports",
    ]) {
      await seed(
        migrator,
        parseSeedArgs(
          ["--tenant", tenantId, "--only", pack, "--fiscal-year", "2026"],
          {} as NodeJS.ProcessEnv,
        ),
        auth,
      );
    }
    expect(await census()).toEqual(before);
  });

  it("the company is fully configured: base currency, timezone, fx-rounding account, twelve open periods, a branch", async () => {
    const [c] = await db.admin<{ base_currency: string; timezone: string; fx: string | null }[]>`
      select base_currency, timezone, fx_rounding_account_id::text as fx from app.company where tenant_id = ${tenantId}`;
    expect(c!.base_currency).toBe("MYR");
    expect(c!.timezone).toBe("Asia/Kuala_Lumpur");
    expect(c!.fx).not.toBeNull();
    const [p] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.fiscal_period where tenant_id = ${tenantId} and status = 'open'`;
    expect(p!.n).toBe(12);
    const [b] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.dimension_value dv join app.dimension_type dt on dt.id = dv.dimension_type_id
       where dt.code = 'BRANCH' and dv.code = 'HQ' and dv.tenant_id = ${tenantId}`;
    expect(b!.n).toBe(1);
  });

  it("but empty: no document, no ledger entry (spec:2317 'an empty but fully configured company')", async () => {
    const [d] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.document where tenant_id = ${tenantId}`;
    const [l] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.ledger_entry where tenant_id = ${tenantId}`;
    expect([d!.n, l!.n]).toEqual([0, 0]);
  });
});
