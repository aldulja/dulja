import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  listStatutoryProfiles,
  openStatutoryProfile,
  profileOn,
  type StatutoryProfileInput,
} from "../../src/hr/statutory-profile";
import { grantCodes, seedEmployee, seedTenant, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

const profile = (over: Partial<StatutoryProfileInput> = {}): StatutoryProfileInput => ({
  effectiveFrom: "2026-01-01",
  maritalStatus: "single",
  spouseWorking: null,
  childReliefCount: 0,
  residencyCategory: null,
  extra: {},
  ...over,
});

describe("migration 0082 — the effective-dated statutory profile (⚠️ OD-28)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let officer: string;
  let clerk: string;
  let employeeId: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "8a-prof-a");
    b = await seedTenant(db, "8a-prof-b");
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
      codes: ["hr.compensation.read", "hr.compensation.manage"],
      principalId: officer,
      roleCode: "t-prof-officer",
    });
    // `clerk` holds a live role carrying NO code (progress log, T3 decision): app.employee's Form A′
    // branch_isolation would otherwise hide every employee, and the zero below would be branch isolation's
    // rather than compensation_gate's.
    await grantCodes(db, a, { principalId: clerk, roleCode: "t-prof-clerk" });
    await grantCodes(db, b);
    employeeId = await seedEmployee(db, a, { employeeNumber: "E-PROF" });
  }, 180_000);
  afterAll(async () => {
    await db.stop();
  });

  it("carries the three fields spec:2077 names, residency_category, and extra jsonb", async () => {
    const cols = await db.admin<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
       where table_schema = 'app' and table_name = 'employee_statutory_profile' order by 1`;
    const byName = new Map(cols.map((c) => [c.column_name, c.data_type]));
    expect(byName.get("marital_status")).toBe("text");
    expect(byName.get("spouse_working")).toBe("boolean");
    expect(byName.get("child_relief_count")).toBe("integer");
    expect(byName.get("residency_category")).toBe("text");
    expect(byName.get("extra")).toBe("jsonb");
    expect(byName.get("effective_from")).toBe("date");
    expect(byName.get("effective_to")).toBe("date");
  });

  it("opening a second profile closes the first the day before (spec:2077, ADR 0072)", async () => {
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(tx, employeeId, profile()),
    );
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(
        tx,
        employeeId,
        profile({
          effectiveFrom: "2026-07-01",
          maritalStatus: "married",
          spouseWorking: true,
          childReliefCount: 2,
        }),
      ),
    );
    const rows = await withTenant(db.rw, a.tenant, officer, (tx) =>
      listStatutoryProfiles(tx, employeeId),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.effectiveFrom).toBe("2026-07-01");
    expect(rows[0]!.effectiveTo).toBeNull();
    expect(rows[1]!.effectiveTo).toBe("2026-06-30");
    expect(rows[1]!.enteredBy).toBe(officer);
  });

  it("profileOn resolves the row covering a date, and null before the first", async () => {
    expect(
      (await withTenant(db.rw, a.tenant, officer, (tx) => profileOn(tx, employeeId, "2026-03-31")))!
        .maritalStatus,
    ).toBe("single");
    expect(
      (await withTenant(db.rw, a.tenant, officer, (tx) => profileOn(tx, employeeId, "2026-08-15")))!
        .childReliefCount,
    ).toBe(2);
    expect(
      await withTenant(db.rw, a.tenant, officer, (tx) => profileOn(tx, employeeId, "2025-12-31")),
    ).toBeNull();
  });

  it("two rows cannot share an effective_from, and backdating before the open row collides", async () => {
    await expect(
      withTenant(db.rw, a.tenant, officer, (tx) =>
        openStatutoryProfile(tx, employeeId, profile({ effectiveFrom: "2026-07-01" })),
      ),
    ).rejects.toThrow(/employee_statutory_profile_employee_id_effective_from_key|duplicate key/);
    await expect(
      withTenant(db.rw, a.tenant, officer, (tx) =>
        openStatutoryProfile(tx, employeeId, profile({ effectiveFrom: "2026-05-01" })),
      ),
    ).rejects.toThrow(/employee_statutory_profile_open_idx|duplicate key/);
  });

  it("compensation_gate: a principal without hr.compensation.read gets zero rows by direct SQL (test 32)", async () => {
    const rows = await withTenant(
      db.rw,
      a.tenant,
      clerk,
      (tx) => tx<{ id: string }[]>`select id from app.employee_statutory_profile`,
    );
    expect(rows).toHaveLength(0);
    // and the same predicate gates the write (no `with check` — the `using` applies)
    await expect(
      withTenant(db.rw, a.tenant, clerk, (tx) =>
        openStatutoryProfile(tx, employeeId, profile({ effectiveFrom: "2027-01-01" })),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("R4: a principal cannot open their own profile (spec:2175)", async () => {
    const mine = await seedEmployee(db, a, {
      employeeNumber: "E-PROF-SELF",
      principalId: officer,
    });
    await expect(
      withTenant(db.rw, a.tenant, officer, (tx) => openStatutoryProfile(tx, mine, profile())),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
  });

  it("extra jsonb is stored and read back unchanged — the OD-28 seam", async () => {
    const other = await seedEmployee(db, a, { employeeNumber: "E-PROF-X" });
    await withTenant(db.rw, a.tenant, officer, (tx) =>
      openStatutoryProfile(
        tx,
        other,
        profile({
          maritalStatus: null,
          childReliefCount: null,
          extra: { verified_field_a: "value", verified_flag_b: true, verified_count_c: 3 },
        }),
      ),
    );
    const [row] = await withTenant(db.rw, a.tenant, officer, (tx) =>
      listStatutoryProfiles(tx, other),
    );
    expect(row!.extra).toEqual({
      verified_field_a: "value",
      verified_flag_b: true,
      verified_count_c: 3,
    });
  });

  it("tenant B sees nothing of tenant A (test 12)", async () => {
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ id: string }[]>`
        select id from app.employee_statutory_profile where employee_id = ${employeeId}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("the schema linter reports zero violations, and one when compensation_gate is dropped", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    await db.admin`drop policy compensation_gate on app.employee_statutory_profile`;
    expect(await lintSchema(db.admin)).toContainEqual({
      table: "employee_statutory_profile",
      rule: "sensitive_gate",
      detail:
        "no RESTRICTIVE policy named compensation_gate (spec:2076 — a permission gate is OR-ed away when permissive, LEGACY-033)",
    });
    await db.admin`create policy compensation_gate on app.employee_statutory_profile as restrictive
      using (app.actor_has('hr.compensation.read', (select e.company_id from app.employee e where e.id = employee_id)))`;
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
