import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { seed } from "../src/seed";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { parseSeedArgs } from "../src/seed/config";
import { startDb, type Db } from "./harness";

describe("the fiscal-periods loader — the current fiscal year (spec:2001)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  const run = async (extra: readonly string[]) => {
    const tenantId = randomUUID();
    const cfg = parseSeedArgs(
      ["--tenant", tenantId, "--fiscal-year", "2026", "--only", "fiscal-periods", ...extra],
      {} as NodeJS.ProcessEnv,
    );
    const r = await seed(migrator, cfg, new StubSeedAuthAdmin());
    const rows = await db.admin<{ starts_on: string; ends_on: string; status: string }[]>`
      select starts_on::text, ends_on::text, status::text from app.fiscal_period
       where company_id = ${r.companyId} order by starts_on`;
    return { r, rows };
  };

  it("a January year start gives twelve open calendar months, first to last day", async () => {
    const { r, rows } = await run([]);
    expect(r.applied["fiscal-periods"]).toBe(12);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ starts_on: "2026-01-01", ends_on: "2026-01-31", status: "open" });
    expect(rows[1]!.ends_on).toBe("2026-02-28"); // 2026 is not a leap year
    expect(rows[11]).toEqual({ starts_on: "2026-12-01", ends_on: "2026-12-31", status: "open" });
  });

  it("an April year start runs April 2026 to March 2027 with no gap and no overlap", async () => {
    const { rows } = await run(["--fiscal-year-start", "4"]);
    expect(rows[0]!.starts_on).toBe("2026-04-01");
    expect(rows[11]!.ends_on).toBe("2027-03-31");
    for (let i = 1; i < rows.length; i++) {
      const previousEnd = new Date(`${rows[i - 1]!.ends_on}T00:00:00Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
      expect(rows[i]!.starts_on).toBe(previousEnd.toISOString().slice(0, 10));
    }
  });

  it("re-running inserts nothing — the overlap exclusion constraint arbitrates the targetless DO NOTHING", async () => {
    const tenantId = randomUUID();
    const cfg = () =>
      parseSeedArgs(
        ["--tenant", tenantId, "--fiscal-year", "2026", "--only", "fiscal-periods"],
        {} as NodeJS.ProcessEnv,
      );
    await seed(migrator, cfg(), new StubSeedAuthAdmin());
    const again = await seed(migrator, cfg(), new StubSeedAuthAdmin());
    expect(again.applied["fiscal-periods"]).toBe(0);
  });
});
