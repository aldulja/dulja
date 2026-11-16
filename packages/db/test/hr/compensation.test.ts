import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Money, Quantity, currency } from "@dulja/domain";
import { lintSchema } from "../../src/lint-schema";
import {
  compensationOn,
  listCompensation,
  listPayComponents,
  openCompensation,
  setComponentSchemes,
} from "../../src/hr/compensation";
import {
  grantCodes,
  seedEmployee,
  seedPayComponent,
  seedStatutoryScheme,
  seedTenant,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const MYR = currency("MYR");

describe("migration 0083 — pay components, the scheme join, and effective-dated compensation", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let officer: string;
  let clerk: string;
  let employeeId: string;
  let basicId: string;
  let unpaidId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-comp-a");
    b = await seedTenant(db, "8a-comp-b");
    officer = await uuidv7(db.admin);
    clerk = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      for (const [id, n] of [
        [officer, "Officer"],
        [clerk, "Clerk"],
      ] as const) {
        await tx`insert into app.principal (id, auth_subject, kind, display_name)
                 values (${id}, ${`sub-${id}`}, 'human', ${n})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${id})`;
      }
    });
    await grantCodes(db, a, {
      codes: ["hr.compensation.read", "hr.compensation.manage", "hr.pay_component.manage"],
      principalId: officer,
      roleCode: "t-comp-officer",
    });
    // `clerk` holds a live role carrying NO code, so the zero below is compensation_gate's and not 6C's branch
    // isolation on app.employee (progress log, T3 decision).
    await grantCodes(db, a, { principalId: clerk, roleCode: "t-comp-clerk" });
    await grantCodes(db, b);
    employeeId = await seedEmployee(db, a, { employeeNumber: "E-COMP" });
    basicId = await seedPayComponent(db, a, { code: "BASIC", kind: "earning" });
    unpaidId = await seedPayComponent(db, a, {
      code: "UNPAID_LEAVE",
      kind: "deduction",
      quantityBased: true,
    });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("pay_component.kind admits exactly two values — never a third for employer contributions (spec:2079)", async () => {
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        officer,
        (tx) => tx`
        insert into app.pay_component (tenant_id, company_id, code, name_en, kind)
        values (${a.tenant}, ${a.company}, 'EMPLOYER_X', 'Employer share', 'employer_contribution')`,
      ),
    ).rejects.toThrow(/pay_component_kind_check/);
  });

  it("pay_component_scheme is a join table with no id and no created_at (§3.5.3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'pay_component_scheme'`;
    expect(cols.map((c) => c.column_name).toSorted()).toEqual([
      "component_id",
      "scheme_id",
      "tenant_id",
    ]);
  });

  it("no component carries a `subject to` boolean — the join table is the only applicability store (RC-3)", async () => {
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'pay_component'`;
    expect(
      cols.map((c) => c.column_name).filter((n) => /^subject_|_epf$|_socso$|_eis$|_pcb$/.test(n)),
    ).toEqual([]);
  });

  it("expense_account_id and payable_account_id are NULLABLE — 8B seeds the accounts (§4.12.2, A2)", async () => {
    const cols = await db.admin<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
       where table_schema = 'app' and table_name = 'pay_component' and column_name like '%account_id'`;
    expect(cols).toHaveLength(2);
    expect(cols.every((c) => c.is_nullable === "YES")).toBe(true);
  });

  it("an amount is numeric(19,4) and survives a round trip through Money", async () => {
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openCompensation(tx, {
        employeeId,
        componentId: basicId,
        effectiveFrom: "2026-01-01",
        amount: Money.of("3500.0000", MYR),
        quantity: null,
      }),
    );
    const [line] = await withTenant(db.rw, a.tenant, officer, (tx) =>
      listCompensation(tx, employeeId),
    );
    expect(line!.amount!.toString()).toBe("3500.0000");
    expect(line!.amount!.currency).toBe("MYR");
    expect(line!.enteredBy).toBe(officer);
  });

  it("a raise closes the old line and opens a new one — history IS the closed rows (spec:2077)", async () => {
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openCompensation(tx, {
        employeeId,
        componentId: basicId,
        effectiveFrom: "2026-07-01",
        amount: Money.of("4000.0000", MYR),
        quantity: null,
      }),
    );
    const lines = await withTenant(db.rw, a.tenant, officer, (tx) =>
      listCompensation(tx, employeeId),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.effectiveFrom).toBe("2026-07-01");
    expect(lines[0]!.effectiveTo).toBeNull();
    expect(lines[1]!.effectiveTo).toBe("2026-06-30");
    const march = await withTenant(db.rw, a.tenant, officer, (tx) =>
      compensationOn(tx, employeeId, "2026-03-15"),
    );
    expect(march[0]!.amount!.toString()).toBe("3500.0000");
    const september = await withTenant(db.rw, a.tenant, officer, (tx) =>
      compensationOn(tx, employeeId, "2026-09-15"),
    );
    expect(september[0]!.amount!.toString()).toBe("4000.0000");
  });

  it("two OPEN lines of the same component cannot coexist, but two components can", async () => {
    // Unpaid leave is quantity-based (days x daily rate, spec:2078): a quantity, no amount.
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openCompensation(tx, {
        employeeId,
        componentId: unpaidId,
        effectiveFrom: "2026-07-01",
        amount: null,
        quantity: Quantity.of("2.000000"),
      }),
    );
    const open = await withTenant(
      db.rw,
      a.tenant,
      officer,
      (tx) => tx<{ n: string }[]>`
        select count(*)::text as n from app.compensation_line
         where employee_id = ${employeeId} and effective_to is null`,
    );
    expect(open[0]!.n).toBe("2");
    await expect(
      withTenant(
        db.rw,
        a.tenant,
        officer,
        (tx) => tx`
        insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount)
        values (${a.tenant}, ${employeeId}, ${basicId}, '2026-08-01', 4200.0000)`,
      ),
    ).rejects.toThrow(/compensation_line_open_idx|duplicate key/);
  });

  it("a line with neither amount nor quantity is refused by the database", async () => {
    await expect(
      withTenant(db.rw, a.tenant, officer, (tx) =>
        openCompensation(tx, {
          employeeId,
          componentId: unpaidId,
          effectiveFrom: "2027-01-01",
          amount: null,
          quantity: null,
        }),
      ),
    ).rejects.toThrow(/compensation_line_check/);
  });

  it("a component of ANOTHER company cannot be put on this employee — the FK bounds only the tenant", async () => {
    const otherCompany = await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${a.tenant}, 'COMP-OTHER', 'Other company', 'MYR') returning id`;
      const [pc] = await tx<{ id: string }[]>`
        insert into app.pay_component (tenant_id, company_id, code, name_en, kind)
        values (${a.tenant}, ${c!.id}, 'BASIC', 'Basic', 'earning') returning id`;
      return pc!.id;
    });
    await expect(
      withTenant(db.rw, a.tenant, officer, (tx) =>
        openCompensation(tx, {
          employeeId,
          componentId: otherCompany,
          effectiveFrom: "2028-01-01",
          amount: Money.of("1.0000", MYR),
          quantity: null,
        }),
      ),
    ).rejects.toThrow(/different companies/);
  });

  it("compensation_gate: a principal without hr.compensation.read gets zero rows by direct SQL (test 32)", async () => {
    const rows = await withTenant(
      db.rw,
      a.tenant,
      clerk,
      (tx) => tx<{ id: string }[]>`select id from app.compensation_line`,
    );
    expect(rows).toHaveLength(0);
  });

  it("R4: a principal cannot open their own compensation line (spec:2175, test 31)", async () => {
    const mine = await seedEmployee(db, a, { employeeNumber: "E-COMP-SELF", principalId: officer });
    await expect(
      withTenant(db.rw, a.tenant, officer, (tx) =>
        openCompensation(tx, {
          employeeId: mine,
          componentId: basicId,
          effectiveFrom: "2026-01-01",
          amount: Money.of("9999.0000", MYR),
          quantity: null,
        }),
      ),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
  });

  it("setComponentSchemes is additive and idempotent, and the list aggregates the joins", async () => {
    // A real scheme: migration 0084 constrains scheme_id (A13), so the free uuid this case used before 0084 is refused.
    const scheme = await seedStatutoryScheme(db, a, { code: "SYNTH" });
    await withTenant(db.rw, a.tenant, officer, async (tx) => {
      await setComponentSchemes(tx, basicId, [scheme]);
      await setComponentSchemes(tx, basicId, [scheme]);
    });
    const comps = await withTenant(db.rw, a.tenant, officer, (tx) =>
      listPayComponents(tx, a.company),
    );
    expect(comps.find((c) => c.id === basicId)!.schemeIds).toEqual([scheme]);
    expect(comps.find((c) => c.id === unpaidId)!.schemeIds).toEqual([]);
    expect(comps.map((c) => c.code)).toEqual(["UNPAID_LEAVE", "BASIC"]); // by kind, then code
  });

  it("tenant B sees no component and no line of tenant A (test 12)", async () => {
    const comps = await withTenant(db.rw, b.tenant, b.human, (tx) =>
      listPayComponents(tx, a.company),
    );
    expect(comps).toHaveLength(0);
    const lines = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.compensation_line where employee_id = ${employeeId}`,
    );
    expect(lines).toHaveLength(0);
    const joins = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: string }[]>`select count(*)::text as n from app.pay_component_scheme`,
    );
    expect(joins[0]!.n).toBe("0");
  });

  it("the schema linter reports zero violations after 0083", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("no payroll account exists after 0083 — 8A seeds none (hazard 33, A2)", async () => {
    const [n] = await db.admin<{ n: string }[]>`
      select count(*)::text as n from app.account
       where code in ('2400','1400','5300','2411','2412','2413','2414','5311','5312','5313','5314')`;
    expect(n!.n).toBe("0");
  });
});
