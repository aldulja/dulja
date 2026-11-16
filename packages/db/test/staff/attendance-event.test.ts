import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, withTenant, type Db } from "../harness";
import { seedTenant, seedEmployee, grantCodes, type Seed } from "../fixtures";
import { lintSchema, listApplied } from "../../src";

let db: Db;
let a: Seed;
let b: Seed;
let employee: string;

beforeAll(async () => {
  db = await startDb();
  a = await seedTenant(db, "alpha");
  b = await seedTenant(db, "beta");
  // `app.attendance_event` takes Form A of `branch_isolation` in Task 5's migration 0068 and every insert
  // below is written as `a.human` DELIBERATELY — the whole point of the first case is that `recorded_by`
  // is stamped with the ACTING principal, and the acting principal has to be a human for the assertion to
  // mean anything. One company-wide grant (no `branchIds`) is what lets that human still pass
  // `app.actor_in_branch` after 0068, and it changes nothing about what is asserted. Amendment A15 names
  // this as the remedy for a suite whose actor must stay `s.human`; switching the actor to `s.system`
  // instead would quietly turn the stamp case into an assertion about the system principal.
  await grantCodes(db, a);
  employee = await seedEmployee(db, a, { employeeNumber: "E-ATT" });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

const insert = (s: Seed, actor: string, cols: Record<string, unknown>) =>
  withTenant(
    db.rw,
    s.tenant,
    actor,
    (tx) => tx`
    insert into app.attendance_event (tenant_id, company_id, employee_id, branch_id, kind, occurred_at, terminal_id, recorded_by, note, corrects_event_id)
    values (${s.tenant}, ${s.company}, ${cols.employee_id as string}, ${cols.branch_id as string}, ${cols.kind as string},
            ${cols.occurred_at as string}, ${(cols.terminal_id as string) ?? null},
            ${(cols.recorded_by as string) ?? actor}, ${(cols.note as string) ?? null}, ${(cols.corrects_event_id as string) ?? null})
    returning id, recorded_by`,
  );

describe("app.attendance_event (§4.6.1; spec:2089)", () => {
  it("migration 67 is applied and the kind vocabulary is a CHECK, not an enum (§3.4.4)", async () => {
    expect(await listApplied(db.migrator)).toContain(67);
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.attendance_event'::regclass and conname = 'attendance_event_kind_check'`;
    expect(chk!.def).toContain("clock_in");
    expect(chk!.def).toContain("clock_out");
    expect(chk!.def).toContain("manual_correction");
    const [enumCount] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from pg_type where typnamespace = 'app'::regnamespace and typname = 'attendance_kind'`;
    expect(enumCount!.n).toBe(0);
  });

  it("recorded_by is STAMPED — a supplied value is overwritten with the acting principal (SAH-044)", async () => {
    const [row] = await insert(a, a.human, {
      employee_id: employee,
      branch_id: a.hq,
      kind: "clock_in",
      occurred_at: "2026-01-15T01:00:00Z",
      recorded_by: a.system, // a lie the database refuses to believe
    });
    expect(row!.recorded_by).toBe(a.human);
  });

  it("an unknown kind is refused by the CHECK", async () => {
    await expect(
      insert(a, a.human, {
        employee_id: employee,
        branch_id: a.hq,
        kind: "lunch",
        occurred_at: "2026-01-15T05:00:00Z",
      }),
    ).rejects.toThrow(/attendance_event_kind_check/);
  });

  it("a correction points at an event of the same employee", async () => {
    const [orig] = await insert(a, a.human, {
      employee_id: employee,
      branch_id: a.hq,
      kind: "clock_out",
      occurred_at: "2026-01-15T09:00:00Z",
    });
    const other = await seedEmployee(db, a, { employeeNumber: "E-ATT2" });
    await expect(
      insert(a, a.human, {
        employee_id: other,
        branch_id: a.hq,
        kind: "manual_correction",
        occurred_at: "2026-01-15T09:05:00Z",
        corrects_event_id: orig!.id,
      }),
    ).rejects.toThrow(/attendance_event_corrects_same_employee/);
    await expect(
      insert(a, a.human, {
        employee_id: employee,
        branch_id: a.hq,
        kind: "manual_correction",
        occurred_at: "2026-01-15T09:05:00Z",
        corrects_event_id: orig!.id,
      }),
    ).resolves.toBeTruthy();
  });

  it("a correction must BE a manual_correction — a clock_in cannot correct anything", async () => {
    const [orig] = await insert(a, a.human, {
      employee_id: employee,
      branch_id: a.hq,
      kind: "clock_in",
      occurred_at: "2026-01-16T01:00:00Z",
    });
    await expect(
      insert(a, a.human, {
        employee_id: employee,
        branch_id: a.hq,
        kind: "clock_in",
        occurred_at: "2026-01-16T01:05:00Z",
        corrects_event_id: orig!.id,
      }),
    ).rejects.toThrow(/attendance_event_correction_kind/);
  });

  it("tenant B cannot see tenant A's attendance", async () => {
    const rows = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx`select id from app.attendance_event where employee_id = ${employee}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("the schema linter reports zero violations after 0067", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });
});
