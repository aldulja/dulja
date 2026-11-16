import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  employerRegistrations,
  readHrSetting,
  setEmployerRegistration,
  upsertHrSetting,
} from "../../src/hr/settings";
import { seedStatutoryScheme, seedTenant, type Seed } from "../fixtures";
import { startDb, withTenant, type Db } from "../harness";

describe("migration 0085 — company HR settings (⚠️ OD-23)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-set-a");
    b = await seedTenant(db, "8a-set-b");
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("carries proration_rule and pay_day and NO registrations blob (amendment A4, spec:2088)", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'company_hr_setting' order by 1`;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain("proration_rule");
    expect(names).toContain("pay_day");
    expect(names).not.toContain("employer_registrations");
    expect(cols.filter((c) => c.data_type === "jsonb")).toEqual([]);
  });

  it("⚠️ OD-23: no row exists until one is written — the migration seeds nothing", async () => {
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company)),
    ).toBeNull();
  });

  it("proration_rule admits exactly the two values spec:2086 names", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      upsertHrSetting(tx, { companyId: a.company, prorationRule: "calendar_days", payDay: 25 }),
    );
    expect(
      (await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company)))!
        .prorationRule,
    ).toBe("calendar_days");
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      update app.company_hr_setting set proration_rule = 'thirty_days' where company_id = ${a.company}`,
      ),
    ).rejects.toThrow(/company_hr_setting_proration_rule_check/);
  });

  it("there is at most one row per company", async () => {
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      upsertHrSetting(tx, { companyId: a.company, prorationRule: "working_days", payDay: 28 }),
    );
    const [n] = await withTenant(
      db.rw,
      a.tenant,
      a.human,
      (tx) =>
        tx<
          { n: string }[]
        >`select count(*)::text as n from app.company_hr_setting where company_id = ${a.company}`,
    );
    expect(n!.n).toBe("1");
    const stored = await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company));
    expect(stored).toEqual({ companyId: a.company, prorationRule: "working_days", payDay: 28 });
  });

  it("pay_day is a day of the month or null", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        a.human,
        (tx) => tx`
      update app.company_hr_setting set pay_day = 32 where company_id = ${a.company}`,
      ),
    ).rejects.toThrow(/company_hr_setting_pay_day_check/);
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      upsertHrSetting(tx, { companyId: a.company, prorationRule: "working_days", payDay: null }),
    );
    expect(
      (await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company)))!.payDay,
    ).toBeNull();
  });

  it("employer registrations are RELATIONAL, one per scheme (amendment A3)", async () => {
    const first = await seedStatutoryScheme(db, a, { code: "SYNTH_A" });
    await seedStatutoryScheme(db, a, { code: "SYNTH_B" });
    await withTenant(db.rw, a.tenant, a.human, (tx) =>
      setEmployerRegistration(tx, first, "SYNTHETIC-REG-0001"),
    );
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      employerRegistrations(tx, a.company),
    );
    expect(rows).toEqual([
      { schemeCode: "SYNTH_A", registration: "SYNTHETIC-REG-0001" },
      { schemeCode: "SYNTH_B", registration: null },
    ]);
  });

  it("a registration write on a scheme the transaction cannot see throws instead of succeeding silently", async () => {
    const [victim] = await db.admin<{ id: string }[]>`
      select id from app.statutory_scheme where company_id = ${a.company} order by code limit 1`;
    await expect(
      withTenant(db.rw, b.tenant, b.human, (tx) =>
        setEmployerRegistration(tx, victim!.id, "SYNTHETIC-REG-X"),
      ),
    ).rejects.toThrow(/not visible/);
  });

  it("⚠️ OD-23: nothing in 8A refuses to work while every registration is null", async () => {
    const rows = await withTenant(db.rw, a.tenant, a.human, (tx) =>
      employerRegistrations(tx, a.company),
    );
    expect(rows.some((r) => r.registration === null)).toBe(true);
    expect(
      await withTenant(db.rw, a.tenant, a.human, (tx) => readHrSetting(tx, a.company)),
    ).not.toBeNull();
  });

  it("every write is audited under the session's actor", async () => {
    const rows = await db.admin<{ actor_id: string }[]>`
      select actor_id from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'company_hr_setting'`;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(rows.map((r) => r.actor_id))).toEqual(new Set([a.human]));
  });

  it("tenant B sees no setting of tenant A (test 12)", async () => {
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) =>
        tx<
          { company_id: string }[]
        >`select company_id from app.company_hr_setting where company_id = ${a.company}`,
    );
    expect(rows).toHaveLength(0);
    expect(
      await withTenant(db.rw, b.tenant, b.human, (tx) => readHrSetting(tx, a.company)),
    ).toBeNull();
  });

  it("the schema linter reports zero violations after 0085", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
