import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../../src/lint-schema";
import {
  approveLeave,
  createLeaveType,
  createPublicHoliday,
  LeaveError,
  listEntitlements,
  listLeaveRecords,
  listPublicHolidays,
  rejectLeave,
  requestLeave,
  setEntitlement,
} from "../../src/hr/leave";
import { grantCodes, seedBranch, seedEmployee, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

// 8D Task 8 — ⚠️ OD-13 answered BUILD on 2026-11-07 (contracts round 19, 8D A14): migration 0096's leave register.
// Test 31's leave clause (R4, spec:2175) is proved here on the direct `app_rw` path, the one a route check cannot
// cover; apps/api/test/routes/hr/leave.test.ts proves it again through the API.

describe("migration 0096 — the leave register (⚠️ OD-13, spec:2085)", () => {
  let db: Db;
  let s: Seed;
  let other: Seed;
  /** Holds the leave codes; IS employee E-4002 (`selfEmployeeId`), the R4 subject. */
  let officer: string;
  /** A different principal holding hr.leave.approve. */
  let approver: string;
  /** Restricted to `branchTwo` by a branch grant. */
  let branchOnly: string;
  let branchTwo: string;
  let employeeId: string;
  let selfEmployeeId: string;
  let branchTwoEmployeeId: string;
  let annualTypeId: string;

  const as = <T>(actor: string, fn: (tx: Sql) => Promise<T>) =>
    withTenant<T>(db.rw, s.tenant, actor, fn);
  const ask = (
    actor: string,
    employee: string,
    startsOn: string,
    endsOn = startsOn,
    days = "1.00",
  ) =>
    as(actor, (tx) =>
      requestLeave(tx, {
        companyId: s.company,
        employeeId: employee,
        leaveTypeId: annualTypeId,
        startsOn,
        endsOn,
        days,
        reason: "family",
      }),
    );
  const statusOf = async (id: string) => {
    const [row] = await db.admin<
      { status: string; approved_by: string | null; reason: string | null }[]
    >`
      select status, approved_by, reason from app.leave_record where id = ${id}`;
    return row!;
  };

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "leave");
    other = await seedTenantV2(db, "leave-b");
    const mint = async (name: string) => {
      const id = await uuidv7(db.admin);
      await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
        await tx`insert into app.principal (id, auth_subject, kind, display_name)
                 values (${id}, ${`human:leave:${id}`}, 'human', ${name})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
      });
      return id;
    };
    officer = await mint("Leave officer");
    approver = await mint("Leave approver");
    branchOnly = await mint("Branch two approver");
    branchTwo = await seedBranch(db, s, { code: "LV2", nameEn: "Leave branch two" });
    await grantCodes(db, s, {
      codes: ["hr.employee.read", "hr.leave.record", "hr.leave.approve"],
      principalId: officer,
      roleCode: "leave-officer",
    });
    await grantCodes(db, s, {
      codes: ["hr.employee.read", "hr.leave.approve"],
      principalId: approver,
      roleCode: "leave-approver",
    });
    await grantCodes(db, s, {
      codes: ["hr.employee.read", "hr.leave.record", "hr.leave.approve"],
      principalId: branchOnly,
      roleCode: "leave-branch-two",
      branchIds: [branchTwo],
    });
    employeeId = await seedEmployee(db, s, { employeeNumber: "E-4001" });
    // The officer IS this employee, which is what makes the R4 case non-vacuous (spec:2175).
    selfEmployeeId = await seedEmployee(db, s, { employeeNumber: "E-4002", principalId: officer });
    branchTwoEmployeeId = await seedEmployee(db, s, {
      employeeNumber: "E-4003",
      homeBranchId: branchTwo,
    });
    annualTypeId = await as(officer, (tx) =>
      createLeaveType(tx, {
        companyId: s.company,
        code: "annual",
        nameEn: "Annual leave",
        nameAr: "إجازة سنوية",
        paid: true,
      }),
    );
  }, 240_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the four tables carry the standard set and the schema linter reports zero violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
    const policies = await db.admin<
      { tablename: string; policyname: string; permissive: string }[]
    >`
      select tablename, policyname, permissive from pg_policies
       where schemaname = 'app'
         and tablename in ('leave_type', 'leave_entitlement', 'leave_record', 'public_holiday')
       order by tablename, policyname`;
    expect(policies.map((p) => [p.tablename, p.policyname, p.permissive])).toEqual([
      ["leave_entitlement", "employee_parent_visibility", "RESTRICTIVE"],
      ["leave_entitlement", "tenant_isolation", "PERMISSIVE"],
      ["leave_record", "employee_parent_visibility", "RESTRICTIVE"],
      ["leave_record", "tenant_isolation", "PERMISSIVE"],
      ["leave_type", "tenant_isolation", "PERMISSIVE"],
      ["public_holiday", "branch_isolation", "RESTRICTIVE"],
      ["public_holiday", "tenant_isolation", "PERMISSIVE"],
    ]);
  });

  it("a record starts `requested` with no decider, and the entitlement is not consumed by it", async () => {
    await as(officer, (tx) =>
      setEntitlement(tx, {
        companyId: s.company,
        employeeId,
        year: 2026,
        leaveTypeId: annualTypeId,
        days: "14.00",
      }),
    );
    const id = await ask(officer, employeeId, "2026-04-01", "2026-04-03", "3.00");
    expect(await statusOf(id)).toEqual({
      status: "requested",
      approved_by: null,
      reason: "family",
    });
    const [ent] = await as(officer, (tx) =>
      listEntitlements(tx, { companyId: s.company, employeeId, limit: 10 }),
    );
    expect(ent!.days).toBe("14.00"); // a record, never an accrual (spec:2085)
  });

  it("R4 — a principal cannot approve their OWN leave, on the direct app_rw path too (ERR_HR_SELF_PAY, test 31)", async () => {
    const id = await ask(officer, selfEmployeeId, "2026-05-01", "2026-05-02", "2.00");
    await expect(
      as(officer, (tx) => approveLeave(tx, { companyId: s.company, leaveRecordId: id })),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
    // …and by hand-written SQL, with or without naming a decider: the trigger is the control, not the service.
    await expect(
      as(
        officer,
        (tx) => tx`update app.leave_record set status = 'approved', approved_by = ${approver}
                               where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_HR_SELF_PAY/);
    expect((await statusOf(id)).status).toBe("requested");
    // A DIFFERENT principal succeeds — the refusal is about the actor, not the row.
    expect(
      await as(approver, (tx) => approveLeave(tx, { companyId: s.company, leaveRecordId: id })),
    ).toBe(true);
    expect(await statusOf(id)).toMatchObject({ status: "approved", approved_by: approver });
  });

  it("an employee may WITHDRAW (reject) their own request — R4 forbids approving it, not closing it", async () => {
    const id = await ask(officer, selfEmployeeId, "2026-05-11");
    await as(officer, (tx) =>
      rejectLeave(tx, { companyId: s.company, leaveRecordId: id, reason: "withdrawn" }),
    );
    expect(await statusOf(id)).toEqual({
      status: "rejected",
      approved_by: officer,
      reason: "withdrawn",
    });
  });

  it("the decider is stamped by the server: a supplied approved_by is overwritten (SAH-044)", async () => {
    const id = await ask(officer, employeeId, "2026-06-01");
    await as(
      approver,
      (tx) =>
        tx`update app.leave_record set status = 'approved', approved_by = ${officer} where id = ${id}`,
    );
    expect((await statusOf(id)).approved_by).toBe(approver);
  });

  it("a decided record is final: it cannot be flipped, re-decided, re-dated or have its decider changed", async () => {
    const id = await ask(officer, employeeId, "2026-06-08");
    await as(approver, (tx) =>
      rejectLeave(tx, { companyId: s.company, leaveRecordId: id, reason: "no cover" }),
    );
    const attempts: readonly ((tx: Sql) => Promise<unknown>)[] = [
      (tx: Sql) => approveLeave(tx, { companyId: s.company, leaveRecordId: id }),
      (tx: Sql) => rejectLeave(tx, { companyId: s.company, leaveRecordId: id }),
      (tx: Sql) =>
        tx`update app.leave_record set ends_on = '2026-06-09', days = 2 where id = ${id}`,
      (tx: Sql) => tx`update app.leave_record set approved_by = ${officer} where id = ${id}`,
      (tx: Sql) => tx`update app.leave_record set status = 'requested' where id = ${id}`,
    ];
    for (const attempt of attempts)
      await expect(as(officer, attempt)).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
    expect(await statusOf(id)).toEqual({
      status: "rejected",
      approved_by: approver,
      reason: "no cover",
    });
  });

  it("a record is inserted requested: a pre-approved insert is refused even by a principal who is not the employee", async () => {
    await expect(
      as(
        approver,
        (tx) => tx`
        insert into app.leave_record (tenant_id, company_id, employee_id, leave_type_id, starts_on, ends_on, days,
                                      status, approved_by)
        values (${s.tenant}, ${s.company}, ${employeeId}, ${annualTypeId}, '2026-07-01', '2026-07-01', 1,
                'approved', ${approver})`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("a requested record cannot carry a decider, and cannot claim more days than its span", async () => {
    const id = await ask(officer, employeeId, "2026-07-06");
    await expect(
      as(
        approver,
        (tx) => tx`update app.leave_record set approved_by = ${approver} where id = ${id}`,
      ),
    ).rejects.toThrow(/leave_record_check/);
    await expect(ask(officer, employeeId, "2026-07-13", "2026-07-14", "3.00")).rejects.toThrow(
      /leave_record_check/,
    );
    // Half days are a span's legitimate fraction.
    expect(await ask(officer, employeeId, "2026-07-20", "2026-07-20", "0.50")).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it("an employee or a leave type of ANOTHER company is not found — the company bind is the service's join", async () => {
    const elsewhere = await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        insert into app.company (tenant_id, code, name, base_currency)
        values (${s.tenant}, 'LEAVE-OTHER', 'Other company', 'MYR') returning id`;
      const [t] = await tx<{ id: string }[]>`
        insert into app.leave_type (tenant_id, company_id, code, name_en)
        values (${s.tenant}, ${c!.id}, 'annual', 'Elsewhere') returning id`;
      return { companyId: c!.id, typeId: t!.id };
    });
    const attempt = (leaveTypeId: string, companyId = s.company) =>
      as(s.system, (tx) =>
        requestLeave(tx, {
          companyId,
          employeeId,
          leaveTypeId,
          startsOn: "2026-08-03",
          endsOn: "2026-08-03",
          days: "1.00",
          reason: null,
        }),
      );
    await expect(attempt(elsewhere.typeId)).rejects.toBeInstanceOf(LeaveError);
    await expect(attempt(annualTypeId, elsewhere.companyId)).rejects.toThrow(/ERR_NOT_FOUND/);
    // …and by hand-written SQL the company-bound FK refuses the other company's type (SQLSTATE 23503).
    await expect(
      as(
        s.system,
        (tx) => tx`
        insert into app.leave_record (tenant_id, company_id, employee_id, leave_type_id, starts_on, ends_on, days)
        values (${s.tenant}, ${s.company}, ${employeeId}, ${elsewhere.typeId}, '2026-08-03', '2026-08-03', 1)`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("branch isolation reaches a record through its employee — and so does R4's lookup", async () => {
    const homeId = await ask(officer, employeeId, "2026-09-01");
    const twoId = await ask(officer, branchTwoEmployeeId, "2026-09-02");
    const seen = await as(branchOnly, (tx) =>
      listLeaveRecords(tx, { companyId: s.company, limit: 100 }),
    );
    expect(seen.map((r) => r.employeeId)).toEqual(seen.map(() => branchTwoEmployeeId));
    expect(seen.map((r) => r.id)).toContain(twoId);
    // A record of an employee the approver cannot see is invisible, so it cannot be decided at all — which is what
    // keeps app.forbid_self_pay's RLS-bound employee lookup from ever answering "no such employee".
    expect(
      await as(branchOnly, (tx) =>
        approveLeave(tx, { companyId: s.company, leaveRecordId: homeId }),
      ),
    ).toBe(false);
    expect((await statusOf(homeId)).status).toBe("requested");
    expect(
      await as(branchOnly, (tx) =>
        approveLeave(tx, { companyId: s.company, leaveRecordId: twoId }),
      ),
    ).toBe(true);
    // Nor can a branch-two principal write a record for an employee it cannot see.
    await expect(ask(branchOnly, employeeId, "2026-09-08")).rejects.toThrow(/ERR_NOT_FOUND/);
  });

  it("R4 holds for a branch-restricted approver whose OWN employee row sits outside their branches", async () => {
    // The bypass employee_parent_visibility closes: app.forbid_self_pay() finds the employee under the actor's RLS,
    // so if the record were visible while the employee is not, the self-check would find "no employee" and pass.
    const roaming = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, auth_subject, kind, display_name)
               values (${roaming}, ${`human:leave:${roaming}`}, 'human', 'Roaming approver')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${roaming})`;
    });
    await grantCodes(db, s, {
      codes: ["hr.employee.read", "hr.leave.approve"],
      principalId: roaming,
      roleCode: "leave-roaming",
      branchIds: [branchTwo],
    });
    const roamingEmployeeId = await seedEmployee(db, s, {
      employeeNumber: "E-4004",
      principalId: roaming, // home branch: head office, outside the grant
    });
    const id = await ask(officer, roamingEmployeeId, "2026-09-14");
    expect(
      await as(roaming, (tx) => approveLeave(tx, { companyId: s.company, leaveRecordId: id })),
    ).toBe(false);
    await as(
      roaming,
      (tx) =>
        tx`update app.leave_record set status = 'approved', approved_by = ${roaming} where id = ${id}`,
    );
    expect(await statusOf(id)).toMatchObject({ status: "requested", approved_by: null });
  });

  it("PUT-shaped entitlement: the same natural key REPLACES the figure — there is no accrual engine", async () => {
    const put = (days: string) =>
      as(officer, (tx) =>
        setEntitlement(tx, {
          companyId: s.company,
          employeeId: branchTwoEmployeeId,
          year: 2027,
          leaveTypeId: annualTypeId,
          days,
        }),
      );
    await put("14.00");
    await put("16.00");
    const rows = await as(officer, (tx) =>
      listEntitlements(tx, { companyId: s.company, employeeId: branchTwoEmployeeId, limit: 10 }),
    );
    expect(rows).toEqual([
      {
        employeeId: branchTwoEmployeeId,
        employeeNumber: "E-4003",
        year: 2027,
        leaveTypeId: annualTypeId,
        leaveTypeCode: "annual",
        days: "16.00",
      },
    ]);
    const [stamp] = await db.admin<{ entered_by: string }[]>`
      select entered_by from app.leave_entitlement where employee_id = ${branchTwoEmployeeId}`;
    expect(stamp!.entered_by).toBe(officer);
  });

  it("a company-wide holiday has a NULL branch; a branch holiday is visible only within its branch (Form B)", async () => {
    await as(officer, async (tx) => {
      await createPublicHoliday(tx, {
        companyId: s.company,
        branchId: null,
        holidayOn: "2026-08-31",
        nameEn: "National day",
        nameAr: "اليوم الوطني",
      });
      await createPublicHoliday(tx, {
        companyId: s.company,
        branchId: s.hq,
        holidayOn: "2026-09-16",
        nameEn: "Head office holiday",
        nameAr: null,
      });
    });
    const all = await as(officer, (tx) =>
      listPublicHolidays(tx, { companyId: s.company, limit: 10 }),
    );
    expect(all.map((h) => [h.holidayOn, h.branchId])).toEqual([
      ["2026-08-31", null],
      ["2026-09-16", s.hq],
    ]);
    const branchView = await as(branchOnly, (tx) =>
      listPublicHolidays(tx, { companyId: s.company, limit: 10 }),
    );
    expect(branchView.map((h) => [h.holidayOn, h.branchId])).toEqual([["2026-08-31", null]]);
    // A branch-two principal cannot write a head-office holiday (Form B's check) …
    await expect(
      as(branchOnly, (tx) =>
        createPublicHoliday(tx, {
          companyId: s.company,
          branchId: s.hq,
          holidayOn: "2026-10-01",
          nameEn: "Not mine",
          nameAr: null,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    // … and a branch must be a BRANCH value of this company, not any dimension value the tenant holds.
    await expect(
      as(officer, (tx) =>
        createPublicHoliday(tx, {
          companyId: s.company,
          branchId: other.hq,
          holidayOn: "2026-10-02",
          nameEn: "Elsewhere",
          nameAr: null,
        }),
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
  });

  it("a SECOND company-wide holiday on the same date is refused — `nulls not distinct`", async () => {
    await expect(
      as(officer, (tx) =>
        createPublicHoliday(tx, {
          companyId: s.company,
          branchId: null,
          holidayOn: "2026-08-31",
          nameEn: "National day again",
          nameAr: null,
        }),
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("a second tenant sees none of the four tables' rows (spec:106)", async () => {
    for (const table of ["leave_type", "leave_entitlement", "leave_record", "public_holiday"]) {
      const rows = await withTenant(
        db.rw,
        other.tenant,
        other.system,
        (tx) => tx<{ n: number }[]>`select count(*)::int as n from ${tx(`app.${table}`)}`,
      );
      expect(rows[0]!.n, table).toBe(0);
    }
    // …and its writes cannot name this tenant's rows.
    const id = await ask(officer, employeeId, "2026-11-02");
    const touched = await withTenant(db.rw, other.tenant, other.system, (tx) =>
      approveLeave(tx, { companyId: s.company, leaveRecordId: id }),
    );
    expect(touched).toBe(false);
  });

  it("every write is audited under the acting principal (test 13's re-run)", async () => {
    const rows = await db.admin<{ table_name: string; actors: string[] }[]>`
      select table_name, array_agg(distinct actor_id::text order by actor_id::text) as actors
        from app.audit_log
       where tenant_id = ${s.tenant}
         and table_name in ('leave_type', 'leave_entitlement', 'leave_record', 'public_holiday')
       group by table_name order by table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      "leave_entitlement",
      "leave_record",
      "leave_type",
      "public_holiday",
    ]);
    const recordActors = rows.find((r) => r.table_name === "leave_record")!.actors;
    expect(recordActors).toEqual(expect.arrayContaining([officer, approver]));
  });
});
