import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { rateFor } from "../src/rates/rate-for";
import { seedCurrency, seedRate, seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("migration 0005 — currency and exchange_rate", () => {
  let db: Db;
  let alpha: Seed;
  let beta: Seed;
  beforeAll(async () => {
    db = await startDb();
    alpha = await seedTenant(db, "Alpha");
    beta = await seedTenant(db, "Beta");
  });
  afterAll(async () => {
    await db.stop();
  });

  const codesOf = async (seed: Seed) =>
    (
      await withTenant(
        db.rw,
        seed.tenant,
        seed.human,
        (tx) => tx<{ code: string }[]>`select code from app.currency order by code`,
      )
    ).map((row) => row.code);

  it("passes schema lint and isolates identical currency codes by tenant", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    // seedTenant already gives each tenant its own MYR — it must, since 0008 made company.base_currency
    // a foreign key. So this asserts the same thing it always did, against a row the fixture wrote:
    // two tenants each hold one MYR, and a second MYR within one tenant is refused.
    await expect(seedCurrency(db, alpha, { code: "MYR" })).rejects.toThrow(/unique|duplicate key/);
    expect(await codesOf(alpha)).toEqual(["MYR"]);
    expect(await codesOf(beta)).toEqual(["MYR"]);
  });

  it("carries the display policy: minor units, POS rounding increment and rounding mode", async () => {
    const [row] = await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) => tx<
        {
          code: string;
          name_en: string;
          minor_units: number;
          pos_rounding_increment: string;
          rounding_mode: string;
        }[]
      >`select code, name_en, minor_units, pos_rounding_increment::text, rounding_mode
          from app.currency where code = 'MYR'`,
    );
    expect(row).toEqual({
      code: "MYR",
      name_en: "MYR",
      minor_units: 2,
      pos_rounding_increment: "0.0100",
      rounding_mode: "HALF_AWAY_FROM_ZERO",
    });
  });

  it("closes rounding_mode to the four RoundingMode literals of the domain package", async () => {
    await expect(
      withTenant(
        db.rw,
        alpha.tenant,
        alpha.human,
        (tx) =>
          tx`insert into app.currency (tenant_id, code, name_en, rounding_mode) values (${alpha.tenant}, 'XXX', 'Bad', 'HALF_UP')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("stores policy and stamps exchange-rate provenance", async () => {
    await seedCurrency(db, alpha, { code: "USD" });
    const id = await seedRate(db, alpha, {
      from: "USD",
      to: "MYR",
      on: "2026-01-01",
      rate: "4.68000000",
    });
    const rows = await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) =>
        tx<
          { rate: string; entered_by: string; source: string }[]
        >`select rate::text, entered_by, source from app.exchange_rate where id = ${id}`,
    );
    expect(rows[0]).toEqual({
      rate: "4.68000000",
      entered_by: alpha.human,
      source: `manual:${alpha.human}`,
    });

    // A statement that names some other principal as the author is overwritten by stamp_entered_by.
    const forged = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) => tx`
        insert into app.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source, entered_by)
        values (${alpha.tenant}, ${alpha.company}, 'USD', 'MYR', 4.7, '2026-02-01', 'forged', ${forged})`,
    );
    const [stamped] = await withTenant(
      db.rw,
      alpha.tenant,
      alpha.human,
      (tx) =>
        tx<
          { entered_by: string }[]
        >`select entered_by from app.exchange_rate where effective_from = '2026-02-01'`,
    );
    expect(stamped!.entered_by).toBe(alpha.human);
  });

  it("keeps one rate per company, currency pair and effective date", async () => {
    await expect(
      seedRate(db, alpha, { from: "USD", to: "MYR", on: "2026-01-01", rate: "5.00000000" }),
    ).rejects.toThrow(/unique|duplicate key/);
  });

  it("uses the greatest effective rate and UNIT_RATE identity", async () => {
    await seedRate(db, alpha, { from: "USD", to: "MYR", on: "2026-06-01", rate: "4.80000000" });
    const on = (date: string) =>
      withTenant(db.rw, alpha.tenant, alpha.human, (tx) =>
        rateFor(tx, alpha.company, "USD", "MYR", date),
      );
    expect((await on("2026-01-01"))!.rate).toBe("4.68000000");
    expect((await on("2026-05-31"))!.rate).toBe("4.70000000");
    expect((await on("2026-06-01"))!.rate).toBe("4.80000000");
    expect((await on("2026-12-31"))!.rate).toBe("4.80000000"); // the latest rate persists forward
    expect(await on("2025-12-31")).toBeNull(); // no row before the first effective date (ADR 0009)
    expect(
      await withTenant(db.rw, alpha.tenant, alpha.human, (tx) =>
        rateFor(tx, alpha.company, "MYR", "MYR", "1999-01-01"),
      ),
    ).toEqual({
      from: "MYR",
      to: "MYR",
      rate: "1.00000000",
      effectiveFrom: "0001-01-01",
      source: "unit",
    });
  });

  it("rejects non-positive rates and hides another tenant's company", async () => {
    await expect(
      seedRate(db, alpha, { from: "USD", to: "MYR", on: "2027-01-01", rate: "0.00000000" }),
    ).rejects.toThrow(/check constraint/);
    expect(
      await withTenant(db.rw, beta.tenant, beta.human, (tx) =>
        rateFor(tx, alpha.company, "USD", "MYR", "2026-12-31"),
      ),
    ).toBeNull();
    // Naming another tenant's ids in the row itself is refused by the policy's WITH CHECK, not just hidden.
    await expect(
      withTenant(
        db.rw,
        beta.tenant,
        beta.human,
        (tx) => tx`
          insert into app.exchange_rate (tenant_id, company_id, from_currency, to_currency, rate, effective_from, source)
          values (${alpha.tenant}, ${alpha.company}, 'USD', 'MYR', 9, '2026-07-01', 'forged')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("audits every insert into both tables with the server-supplied actor", async () => {
    const rows = await withTenant(
      db.rw,
      alpha.tenant,
      alpha.system,
      (tx) => tx<{ table_name: string; action: string; actor_id: string }[]>`
        select table_name, action, actor_id from app.audit_log
         where tenant_id = ${alpha.tenant} and table_name in ('currency', 'exchange_rate') order by seq`,
    );
    // Every insert these two tables have taken in this file, in order, each named against the principal that
    // actually made it: the fixture's bootstrap MYR (fixtures.ts:47), written by the *system* principal
    // because 0008 makes a base currency precede its company; then this suite's USD and its three rates,
    // written by the human. The split is the property, not an exception to it — actor_id is whatever
    // app.current_actor() reported, never anything the statement carried, which is the same thing the
    // overwritten `entered_by` above proves from the other side. A list and not a predicate, so a write that
    // stops being audited, or gains an actor nobody supplied, fails here too.
    expect(rows).toEqual([
      { table_name: "currency", action: "insert", actor_id: alpha.system },
      { table_name: "currency", action: "insert", actor_id: alpha.human },
      { table_name: "exchange_rate", action: "insert", actor_id: alpha.human },
      { table_name: "exchange_rate", action: "insert", actor_id: alpha.human },
      { table_name: "exchange_rate", action: "insert", actor_id: alpha.human },
    ]);
  });
});
