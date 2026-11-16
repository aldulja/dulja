import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATASETS,
  DATASET_IDS,
  DATASET_READ_CODES,
  datasetFor,
  isDatasetId,
  type DatasetId,
} from "../../src/reports/datasets";
import { MAX_DATASET_ROWS, type DatasetParams, type DatasetRow } from "../../src/reports/query";
import { ReportError } from "../../src/reports/errors";
import { approveLeave, createLeaveType, rejectLeave, requestLeave } from "../../src/hr/leave";
import { upsertEmployeeYtdOpening, ytdFromEmployeeYtd } from "../../src/hr";
import { currency, Money } from "@dulja/domain";
import {
  ATTENDANCE_EVENTS,
  CONTRACT_ENDS_ON,
  hrReportFixture,
  type HrReportFixture,
} from "../../../../tests/invariants/support/hr-reports";
import { grantCodes, seedTenantV2, type Seed } from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

// 8D T2 — the five HR datasets of §4.16.2 that are not OD-13's (contracts round 19); 8D Task 8 appends `leave_record`
// (⚠️ OD-13 answered build, round 19 A14) and its cases at the end of this describe. Figures come from 8B's SYNTH table through `payrollFixture` (hazard 1): per employee BASIC
// 2000.0000, employee share 50.0000, employer share 100.0000, net 1950.0000.

const HR_FIVE: readonly DatasetId[] = [
  "employee",
  "attendance_event",
  "payroll_line",
  "employee_ytd",
  "statutory_schedule",
];
/** All six 8D members, in registry order: the five above and Task 8's `leave_record`. */
const HR_SIX: readonly DatasetId[] = [...HR_FIVE, "leave_record"];

const params = (companyId: string, over: Partial<DatasetParams> = {}): DatasetParams => ({
  companyId,
  filters: [],
  sort: [],
  limit: 500,
  offset: 0,
  ...over,
});

/** Fixed-scale sum of a numeric column, in SQL — never `Number()` over money. */
async function sumOf(db: Db, values: readonly DatasetRow[], field: string): Promise<string> {
  const [row] = await db.admin<{ total: string }[]>`
    select coalesce(sum(v), 0)::numeric(19,4)::text as total
      from unnest(${values.map((r) => String(r[field]))}::numeric[]) v`;
  return row!.total;
}

describe("the HR datasets — contracts §4.16.2 (8D's six)", () => {
  let db: Db;
  let s: Seed;
  let other: Seed;
  let f: HrReportFixture;

  const run = (id: DatasetId, over: Partial<DatasetParams> = {}, actor?: string) =>
    withTenant(db.rw, s.tenant, actor ?? s.human, (tx) =>
      DATASETS[id].run(tx, params(s.company, over)),
    );

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "hr-datasets");
    other = await seedTenantV2(db, "hr-datasets-other");
    f = await hrReportFixture(db, s);
  }, 300_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the registry is thirty-four: 8D's six appended after 7C's three, each gated on its §4.16.1 read code", () => {
    expect(DATASET_IDS.slice(-6)).toEqual(HR_SIX);
    // 7A's 25 (no `pdc`, OD-09) + 7C's 3 + 8D's 6 = 34: Task 2's five (33) and Task 8's leave_record (round 19 A13
    // item 1; ⚠️ OD-13 answered build, A14).
    expect(DATASET_IDS).toHaveLength(34);
    expect(Object.keys(DATASETS)).toEqual([...DATASET_IDS]);
    for (const id of HR_SIX) expect(DATASETS[id].id, id).toBe(id);
    expect(isDatasetId("leave_record")).toBe(true);
    expect(DATASET_READ_CODES.leave_record).toEqual(["hr.employee.read"]);
    expect(DATASET_READ_CODES.employee).toEqual(["hr.employee.read"]);
    expect(DATASET_READ_CODES.attendance_event).toEqual(["hr.employee.read"]);
    expect(DATASET_READ_CODES.payroll_line).toEqual(["hr.payroll.read"]);
    expect(DATASET_READ_CODES.employee_ytd).toEqual(["hr.payroll.read"]);
    expect(DATASET_READ_CODES.statutory_schedule).toEqual(["hr.payroll.read"]);
    // No HR column declares a stronger code: there is no sensitive or compensation field to protect (test 32).
    for (const id of HR_SIX) {
      expect(
        DATASETS[id].columns.filter((c) => c.requires !== undefined),
        id,
      ).toEqual([]);
    }
  });

  it("an id outside the union is ERR_REPORT_DATASET_UNKNOWN, not a query", () => {
    expect(isDatasetId("employee_salary")).toBe(false);
    try {
      datasetFor("employee_salary");
      expect.unreachable("an unknown dataset must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ReportError);
      expect((e as ReportError).code).toBe("ERR_REPORT_DATASET_UNKNOWN");
    }
  });

  it("employee returns one row per employee with its branch, dates, employment type and contract end", async () => {
    const rows = await run("employee", { sort: [{ field: "employee_number", dir: "asc" }] });
    expect(rows.map((r) => r.employee_number)).toEqual(f.employees.map((e) => e.number));
    expect(rows.map((r) => r.branch_code)).toEqual(f.employees.map((e) => e.branchCode));
    expect(Object.keys(rows[0]!).toSorted()).toEqual(
      DATASETS.employee.columns.map((c) => c.field).toSorted(),
    );
    for (const r of rows) {
      expect(typeof r.hired_on).toBe("string"); // never a Date (7A's rule)
      expect(r.hired_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.active).toBe(true);
    }
    const contractor = rows.find((r) => r.employee_id === f.contractorId)!;
    expect(contractor.employment_type).toBe("contract");
    expect(contractor.position).toBe("Storekeeper");
    expect(contractor.contract_ends_on).toBe(CONTRACT_ENDS_ON);
    const ending = await run("employee", {
      filters: [{ field: "contract_ends_on", op: "lte", value: "2026-06-30" }],
    });
    expect(ending.map((r) => r.employee_id)).toEqual([f.contractorId]);
  });

  it("employee is bounded by branch isolation: a branch-restricted reader sees its branch's staff only", async () => {
    const restricted = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${restricted}, 'human', ${`human:hr-ds:${restricted}`}, 'Branch two reader')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${restricted})`;
    });
    await grantCodes(db, s, {
      codes: ["hr.employee.read"],
      principalId: restricted,
      branchIds: [f.payroll.branchB],
    });
    const rows = await run("employee", {}, restricted);
    expect(rows.map((r) => r.employee_id)).toEqual([f.payroll.employeeBId]);
  });

  it("a company of another tenant reads nothing (RLS is the outer gate)", async () => {
    const rows = await withTenant(db.rw, other.tenant, other.human, (tx) =>
      DATASETS.employee.run(tx, params(s.company)),
    );
    expect(rows).toEqual([]);
  });

  it("attendance_event carries the UTC instant and its date in the COMPANY's timezone, and filters on that date", async () => {
    const rows = await run("attendance_event", {
      sort: [{ field: "occurred_at", dir: "asc" }],
    });
    expect(rows.map((r) => r.occurred_at)).toEqual(
      ATTENDANCE_EVENTS.map((e) => e.at.replace(/\.\d+Z$/, "Z")),
    );
    for (const r of rows) {
      expect(r.employee_id).toBe(f.payroll.employeeAId);
      expect(["clock_in", "clock_out", "manual_correction"]).toContain(r.kind);
    }
    // Asia/Kuala_Lumpur: the 16:30Z clock-out is 00:30 local on 6 January.
    expect(rows.map((r) => r.occurred_on)).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-06",
      "2026-01-06",
    ]);
    const fifth = await run("attendance_event", {
      filters: [{ field: "occurred_on", op: "eq", value: "2026-01-05" }],
    });
    expect(fifth.map((r) => r.kind)).toEqual(["clock_in"]);
    const sixth = await run("attendance_event", {
      filters: [
        { field: "occurred_on", op: "gte", value: "2026-01-06" },
        { field: "occurred_on", op: "lte", value: "2026-01-06" },
      ],
    });
    expect(sixth).toHaveLength(3);
    expect(rows.find((r) => r.kind === "manual_correction")!.note).toBe(
      "corrected by the branch manager",
    );
  });

  it("payroll_line shows posted lines only, with the run's period, the pay-date year and each line's pinned version", async () => {
    const rows = await run("payroll_line");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(["posted", "reversed"]).toContain(r.document_status);
      expect(r.payroll_document_id).toBe(f.runDocumentId);
      expect(r.period_start).toBe(f.periodStart);
      expect(r.pay_date).toBe(f.payDate);
      expect(r.tax_year).toBe(f.taxYear);
      expect(String(r.amount)).toMatch(/^\d+\.\d{4}$/);
      if (r.scheme_id !== null) expect(r.rate_table_version).toBe(1);
    }
    // The February draft's lines exist and are invisible — R3 may still return a run to draft (spec:2174).
    const [draftLines] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line pl
        join app.document_line dl on dl.id = pl.document_line_id
       where dl.document_id = ${f.draftRunDocumentId}`;
    expect(draftLines!.n).toBe(2);
    expect(
      await run("payroll_line", {
        filters: [{ field: "payroll_document_id", op: "eq", value: f.draftRunDocumentId }],
      }),
    ).toEqual([]);
    expect(
      await run("payroll_line", {
        filters: [{ field: "document_status", op: "eq", value: "draft" }],
      }),
    ).toEqual([]);
  });

  it("payroll_line's two signed measures tie to the ledger by an independent path (8D A10)", async () => {
    const rows = await run("payroll_line");
    const ledger = async (code: string) => {
      const [row] = await db.admin<{ total: string }[]>`
        select coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4)::text as total
          from app.ledger_entry le join app.account a on a.id = le.account_id
         where le.document_id = ${f.runDocumentId} and a.code = ${code}`;
      return row!.total;
    };
    // Σ net_contribution re-derives net from the component and scheme lines and scores the net-pay leg zero, so it
    // equals the 2400 credit (Σ net) — not twice it.
    expect(await sumOf(db, rows, "net_contribution")).toBe(await ledger("2400"));
    expect(await sumOf(db, rows, "net_contribution")).toBe("3900.0000");
    // Σ payable_contribution is both shares of every scheme line = the scheme payable's credit (2411 for EPF).
    expect(await sumOf(db, rows, "payable_contribution")).toBe(await ledger("2411"));
    expect(await sumOf(db, rows, "payable_contribution")).toBe("300.0000");
    // The net-pay legs themselves contribute zero.
    const netLegs = rows.filter((r) => r.component_id === null && r.scheme_id === null);
    expect(netLegs).toHaveLength(2);
    for (const r of netLegs) expect(r.net_contribution).toBe("0.0000");
    // A filter on a measure goes through its `ref`, the select through its own CASE: the two must agree.
    const negative = await run("payroll_line", {
      filters: [{ field: "net_contribution", op: "lt", value: "0" }],
    });
    expect(negative.map((r) => r.payroll_line_id).toSorted()).toEqual(
      rows
        .filter((r) => String(r.net_contribution).startsWith("-"))
        .map((r) => r.payroll_line_id)
        .toSorted(),
    );
    expect(negative.every((r) => r.share === "employee")).toBe(true);
    const payable = await run("payroll_line", {
      filters: [{ field: "payable_contribution", op: "gt", value: "0" }],
    });
    expect(payable.map((r) => r.payroll_line_id).toSorted()).toEqual(
      rows
        .filter((r) => r.scheme_id !== null)
        .map((r) => r.payroll_line_id)
        .toSorted(),
    );
  });

  it("employee_ytd yields one row per (employee, year, scheme) with gross and net repeated, matching the projection", async () => {
    const rows = await run("employee_ytd", { sort: [{ field: "employee_number", dir: "asc" }] });
    expect(rows.length).toBeGreaterThan(0);
    const stored = await db.admin<{ employee_id: string; gross: string; net: string }[]>`
      select employee_id, gross::text, net::text from app.employee_ytd
       where company_id = ${s.company} and tax_year = ${f.taxYear}`;
    expect(stored).toHaveLength(2);
    for (const y of stored) {
      const mine = rows.filter((r) => r.employee_id === y.employee_id);
      expect(mine.length).toBeGreaterThan(0);
      for (const r of mine) {
        expect(r.tax_year).toBe(f.taxYear);
        expect(r.gross).toBe(y.gross); // repeated on every scheme row
        expect(r.net).toBe(y.net);
        expect(r.scheme_code).toBe("EPF");
        expect(r.scheme_employee).toBe("50.0000");
        expect(r.scheme_employer).toBe("100.0000");
      }
    }
    // The contractor is on no run and has no projection row.
    expect(rows.some((r) => r.employee_id === f.contractorId)).toBe(false);
  });

  it("employee_ytd keeps an employee with no scheme as ONE row with a null scheme", async () => {
    // A projection row with an empty scheme bag, written as the migrator would never be by product code — this is
    // a read test of the unnest's left join, inside a transaction that is rolled back.
    const rows = await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.employee_ytd (tenant_id, company_id, employee_id, tax_year, gross, net)
               values (${s.tenant}, ${s.company}, ${f.contractorId}, 2026, '10.0000', '10.0000')`;
      const out = await DATASETS.employee_ytd.run(
        tx,
        params(s.company, {
          filters: [{ field: "employee_id", op: "eq", value: f.contractorId }],
        }),
      );
      throw Object.assign(new Error("rollback"), { out });
    }).catch((e: { out?: DatasetRow[] }) => e.out ?? []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scheme_code).toBeNull();
    expect(rows[0]!.scheme_employee).toBe("0.0000");
  });

  it("employee_ytd adds the cut-over opening at read time (round 18 B14) — gross, net and each scheme's shares — and lists an opening-only employee", async () => {
    // 9B — the Phase 8 raise (contracts round 18 B14, round 19 item 16). The projection stays the posting service's
    // alone; the opening is 8C's `employee_ytd_opening`, written here by its one writer inside a rolled-back
    // transaction so the shared fixture is untouched. Employee A: the projection plus an opening that carries EPF
    // shares and a scheme the projection lacks; the contractor: an opening and no posted run at all.
    const MYR = currency("MYR");
    const opening = (
      employeeId: string,
      gross: string,
      net: string,
      byScheme: Record<string, { employee: string; employer: string }>,
    ) => ({
      companyId: s.company,
      employeeId,
      year: f.taxYear,
      gross: Money.of(gross, MYR),
      net: Money.of(net, MYR),
      byComponent: {},
      byScheme,
      source: "manual:9B read-time addend test",
    });
    const out = await withTenant(db.rw, s.tenant, s.system, async (tx) => {
      const ctx = { tenantId: s.tenant, actorId: s.system, requestId: randomUUID() };
      await upsertEmployeeYtdOpening(
        tx,
        ctx,
        opening(f.payroll.employeeAId, "12000.0000", "11000.0000", {
          EPF: { employee: "600.0000", employer: "1200.0000" },
          SOCSO: { employee: "30.0000", employer: "70.0000" },
        }),
      );
      await upsertEmployeeYtdOpening(tx, ctx, opening(f.contractorId, "500.0000", "500.0000", {}));
      const rows = await DATASETS.employee_ytd.run(
        tx,
        params(s.company, { filters: [{ field: "tax_year", op: "eq", value: String(f.taxYear) }] }),
      );
      const addend = await ytdFromEmployeeYtd(tx, s.company, f.taxYear, [
        f.payroll.employeeAId,
        f.payroll.employeeBId,
        f.contractorId,
      ]);
      const [projected] = await tx<{ gross: string; net: string }[]>`
        select gross::text, net::text from app.employee_ytd
         where company_id = ${s.company} and employee_id = ${f.payroll.employeeAId} and tax_year = ${f.taxYear}`;
      throw Object.assign(new Error("rollback"), { out: { rows, addend, projected } });
    }).catch(
      (e: {
        out?: {
          rows: DatasetRow[];
          addend: Record<string, Record<string, Money>>;
          projected: { gross: string; net: string };
        };
      }) => {
        if (e.out === undefined) throw e;
        return e.out;
      },
    );
    const a = out.rows.filter((r) => r.employee_id === f.payroll.employeeAId);
    // gross and net repeat on every scheme row, and equal the projection plus the opening — `ytdFromEmployeeYtd`'s sum.
    const want = {
      gross: Money.of(out.projected.gross, MYR).add(Money.of("12000.0000", MYR)).toString(),
      net: Money.of(out.projected.net, MYR).add(Money.of("11000.0000", MYR)).toString(),
    };
    for (const r of a) expect({ gross: r.gross, net: r.net }).toEqual(want);
    expect(out.addend[f.payroll.employeeAId]!["gross"]!.toString()).toBe(want.gross);
    expect(out.addend[f.payroll.employeeAId]!["net"]!.toString()).toBe(want.net);
    expect(a.map((r) => [r.scheme_code, r.scheme_employee, r.scheme_employer])).toEqual([
      ["EPF", "650.0000", "1300.0000"],
      ["SOCSO", "30.0000", "70.0000"],
    ]);
    // Employee B has no opening: its rows are the projection's, unchanged.
    const b = out.rows.filter((r) => r.employee_id === f.payroll.employeeBId);
    expect(b.map((r) => [r.scheme_code, r.scheme_employee, r.scheme_employer])).toEqual([
      ["EPF", "50.0000", "100.0000"],
    ]);
    expect(b[0]!.gross).toBe(out.addend[f.payroll.employeeBId]!["gross"]!.toString());
    // The contractor is on no run: one row, from the opening alone, with no scheme.
    const c = out.rows.filter((r) => r.employee_id === f.contractorId);
    expect(c.map((r) => [r.gross, r.net, r.scheme_code, r.scheme_employee])).toEqual([
      ["500.0000", "500.0000", null, "0.0000"],
    ]);
    // The projection was never written by the read (B14): it still holds two rows for the year, the openings none.
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.employee_ytd where company_id = ${s.company} and tax_year = ${f.taxYear}`;
    expect(n!.n).toBe(2);
  });

  it("statutory_schedule carries each scheme's two totals and whether a remittance settled it", async () => {
    const rows = await run("statutory_schedule");
    expect(rows).toHaveLength(f.schedules.length);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => String(r.scheme_code)).toSorted()).toEqual(
      f.schedules.map((x) => x.schemeCode).toSorted(),
    );
    for (const r of rows) {
      const generated = f.schedules.find((x) => x.scheduleId === r.statutory_schedule_id)!;
      expect(r.total_employee).toBe(generated.totalEmployee.toString());
      expect(r.total_employer).toBe(generated.totalEmployer.toString());
      expect(r.total).toBe("300.0000");
      expect(r.payroll_document_id).toBe(f.runDocumentId);
      expect(r.payable_account_code).toBe("2411");
      expect(r.remitted).toBe(false);
      expect(r.remittance_number).toBeNull();
      expect(r.scheme_code).toMatch(/^[A-Z][A-Z0-9_]{1,15}$/);
    }
    expect(
      await run("statutory_schedule", {
        filters: [{ field: "remitted", op: "eq", value: "true" }],
      }),
    ).toEqual([]);
  });

  // ── leave_record (8D Task 8, ⚠️ OD-13 answered build) ─────────────────────────────────────────────────────────
  // Written through the service as the tenant's system principal (branch isolation admits it; R4 is not the
  // subject here — packages/db/test/hr/leave.test.ts proves it). Employee A takes three days of annual leave in
  // March (approved) and one unpaid day in April (still requested); employee B asks for one sick day (rejected).
  describe("leave_record", () => {
    let leave: { approved: string; requested: string; rejected: string; annual: string };
    beforeAll(async () => {
      leave = await withTenant(db.rw, s.tenant, s.system, async (tx) => {
        const type = (code: "annual" | "sick" | "unpaid", nameEn: string, paid: boolean) =>
          createLeaveType(tx, { companyId: s.company, code, nameEn, nameAr: null, paid });
        const annual = await type("annual", "Annual leave", true);
        const sick = await type("sick", "Sick leave", true);
        const unpaid = await type("unpaid", "Unpaid leave", false);
        const ask = (
          employeeId: string,
          leaveTypeId: string,
          startsOn: string,
          endsOn: string,
          days: string,
        ) =>
          requestLeave(tx, {
            companyId: s.company,
            employeeId,
            leaveTypeId,
            startsOn,
            endsOn,
            days,
            reason: null,
          });
        const approved = await ask(
          f.payroll.employeeAId,
          annual,
          "2026-03-02",
          "2026-03-04",
          "3.00",
        );
        const requested = await ask(
          f.payroll.employeeAId,
          unpaid,
          "2026-04-06",
          "2026-04-06",
          "1.00",
        );
        const rejected = await ask(f.payroll.employeeBId, sick, "2026-03-10", "2026-03-10", "1.00");
        await approveLeave(tx, { companyId: s.company, leaveRecordId: approved });
        await rejectLeave(tx, {
          companyId: s.company,
          leaveRecordId: rejected,
          reason: "no cover",
        });
        return { approved, requested, rejected, annual };
      });
    });

    it("serves every record of the company with its employee, type, span and decision, newest first", async () => {
      const rows = await run("leave_record");
      expect(rows.map((r) => r.leave_record_id)).toEqual([
        leave.requested,
        leave.rejected,
        leave.approved,
      ]);
      expect(Object.keys(rows[0]!).toSorted()).toEqual(
        DATASETS.leave_record.columns.map((c) => c.field).toSorted(),
      );
      const approved = rows.find((r) => r.leave_record_id === leave.approved)!;
      expect(approved).toMatchObject({
        employee_id: f.payroll.employeeAId,
        leave_type_id: leave.annual,
        leave_type_code: "annual",
        paid: true,
        starts_on: "2026-03-02",
        ends_on: "2026-03-04",
        days: "3.00",
        status: "approved",
        approved_by: s.system,
      });
      const rejected = rows.find((r) => r.leave_record_id === leave.rejected)!;
      expect(rejected).toMatchObject({
        status: "rejected",
        approved_by: s.system,
        reason: "no cover",
      });
      const requested = rows.find((r) => r.leave_record_id === leave.requested)!;
      expect(requested).toMatchObject({ status: "requested", approved_by: null, paid: false });
    });

    it("filters on status, type and the start date — bound values, never SQL text", async () => {
      const approved = await run("leave_record", {
        filters: [{ field: "status", op: "eq", value: "approved" }],
      });
      expect(approved.map((r) => r.leave_record_id)).toEqual([leave.approved]);
      const march = await run("leave_record", {
        filters: [
          { field: "starts_on", op: "gte", value: "2026-03-01" },
          { field: "starts_on", op: "lte", value: "2026-03-31" },
        ],
      });
      expect(march.map((r) => r.leave_record_id).toSorted()).toEqual(
        [leave.approved, leave.rejected].toSorted(),
      );
      expect(await sumOf(db, march, "days")).toBe("4.0000");
    });

    it("a company of another tenant reads nothing", async () => {
      const rows = await withTenant(db.rw, other.tenant, other.human, (tx) =>
        DATASETS.leave_record.run(tx, params(s.company)),
      );
      expect(rows).toEqual([]);
    });
  });

  it("an undeclared filter field is refused before any SQL is built", async () => {
    await expect(
      run("employee", { filters: [{ field: "national_id", op: "eq", value: "x" }] }),
    ).rejects.toThrow(ReportError);
  });

  it("no HR dataset names a sensitive or compensation table anywhere in its source (test 32)", () => {
    const source = readFileSync(join(__dirname, "../../src/reports/datasets/hr.ts"), "utf8");
    for (const forbidden of [
      "employee_sensitive",
      "compensation_line",
      "employee_statutory_profile",
      "_enc",
    ]) {
      expect(source, `${forbidden} must never reach a dataset — test 32`).not.toContain(forbidden);
    }
    // …and no dataset writes the posting-only projection it reads (hazard 22).
    expect(source).not.toMatch(/\b(insert|update|delete|merge)\s+(into\s+)?app\.employee_ytd\b/i);
  });

  it("every HR dataset clamps to MAX_DATASET_ROWS", async () => {
    for (const id of HR_SIX) {
      const rows = await run(id, { limit: MAX_DATASET_ROWS + 1_000 });
      expect(rows.length, id).toBeLessThanOrEqual(MAX_DATASET_ROWS);
    }
  });
});
