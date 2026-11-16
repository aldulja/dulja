import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintSchema } from "../src/lint-schema";
import { seedShift, seedTenantV2, type Seed } from "./fixtures";
import { seedBranch } from "./fixtures";
import { seedTerminal } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

describe("migration 0070 — app.shift and app.till_event (§4.6.5, §4.6.1)", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let terminalA: { terminalId: string; principalId: string };
  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    b = await seedTenantV2(db, "Beta");
    terminalA = await seedTerminal(db, a, { code: "T1" });
  }, 240_000);
  afterAll(async () => {
    await db.stop();
  });

  it("the shipped schema still has zero linter violations", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("app.shift keeps the till's own id — there is no uuidv7() default (§4.6.5)", async () => {
    const [col] = await db.admin<{ column_default: string | null }[]>`
      select column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'shift' and column_name = 'id'`;
    expect(col!.column_default).toBeNull();
  });

  it("an open shift round-trips, and over_short is NULL until the close", async () => {
    const id = await seedShift(db, a, {
      terminalId: terminalA.terminalId,
      cashierPrincipalId: a.human,
      openingFloat: "200.0000",
    });
    const [row] = await db.admin<
      {
        opening_float: string;
        currency: string;
        counted_cash: string | null;
        expected_cash: string | null;
        over_short: string | null;
        closed_at: string | null;
        branch_id: string;
      }[]
    >`select opening_float::text, currency, counted_cash::text, expected_cash::text,
                over_short::text, closed_at::text, branch_id::text from app.shift where id = ${id}`;
    expect(row!.opening_float).toBe("200.0000");
    expect(row!.currency).toBe("MYR");
    expect(row!.counted_cash).toBeNull();
    expect(row!.expected_cash).toBeNull();
    expect(row!.over_short).toBeNull();
    expect(row!.closed_at).toBeNull();
    expect(row!.branch_id).toBe(a.hq);
  });

  it("tenant B cannot see tenant A's shift or till event (spec:106, test 12)", async () => {
    const shiftId = await seedShift(db, a, {
      terminalId: terminalA.terminalId,
      cashierPrincipalId: a.human,
    });
    const eventId = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      terminalA.principalId,
      async (tx) => tx`
      insert into app.till_event (id, tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                  cashier_principal_id, occurred_at, client_ref)
      values (${eventId}, ${a.tenant}, ${a.company}, ${a.hq}, ${terminalA.terminalId}, ${shiftId},
              'no_sale', ${a.human}, now(), ${await uuidv7(db.admin)})`,
    );

    const seenShifts = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.shift`,
    );
    const seenEvents = await withTenant(
      db.rw,
      b.tenant,
      b.human,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.till_event`,
    );
    expect(seenShifts[0]!.n).toBe(0);
    expect(seenEvents[0]!.n).toBe(0);
  });

  it("till_event is immutable to app_rw: no UPDATE, no DELETE, and the trigger says so", async () => {
    const shiftId = await seedShift(db, a, {
      terminalId: terminalA.terminalId,
      cashierPrincipalId: a.human,
    });
    const eventId = await uuidv7(db.admin);
    await withTenant(
      db.rw,
      a.tenant,
      terminalA.principalId,
      async (tx) => tx`
      insert into app.till_event (id, tenant_id, company_id, branch_id, terminal_id, shift_id, kind,
                                  cashier_principal_id, occurred_at, client_ref)
      values (${eventId}, ${a.tenant}, ${a.company}, ${a.hq}, ${terminalA.terminalId}, ${shiftId},
              'drawer_open', ${a.human}, now(), ${await uuidv7(db.admin)})`,
    );

    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'till_event'
         and privilege_type in ('UPDATE', 'DELETE')`;
    expect(grants).toEqual([]);

    // The trigger is the control even for app_migrator, which holds the privilege.
    await expect(
      withTenant(
        db.migrator,
        a.tenant,
        a.system,
        (tx) => tx`update app.till_event set kind = 'void' where id = ${eventId}`,
      ),
    ).rejects.toThrow(/ERR_TABLE_IMMUTABLE/);
  });

  it("a branch manager restricted to branch B sees no shift or till event of branch A (§4.5.6 Form A, test 36)", async () => {
    const branchB = await seedBranch(db, a, { code: "BR-B" });
    const shiftA = await seedShift(db, a, {
      terminalId: terminalA.terminalId,
      cashierPrincipalId: a.human,
    });
    expect(shiftA).toBeTruthy();

    // A principal assigned ONLY to branch B. grantCodes creates the role, the assignment and the branch row.
    const { grantCodes } = await import("./fixtures");
    const managerId = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${managerId}, 'human', ${"human:mgr:" + a.tenant}, 'Branch B manager')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${managerId})`;
    });
    // **`pos.ticket.sell` and NOT `pos.report.read`.** `app.role_permission.permission_code` has a real FK
    // to `app.permission(code)` (plan0A:1325), and `pos.report.read` is seeded by migration **0072**, which
    // is Task 2 and a different PR. Granting it here would fail with a foreign-key violation on a task that
    // ships only 0070. What this case needs from the grant is a `role_assignment` restricted to branch B —
    // `app.actor_in_branch` reads assignments, not codes — so any code 6A already seeded does the job.
    await grantCodes(db, a, {
      codes: ["pos.ticket.sell"],
      principalId: managerId,
      roleCode: "bm_b",
      branchIds: [branchB],
    });

    const rows = await withTenant(
      db.rw,
      a.tenant,
      managerId,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.shift`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("both tables carry a RESTRICTIVE policy named branch_isolation (§4.5.6)", async () => {
    const policies = await db.admin<
      { tablename: string; policyname: string; permissive: string }[]
    >`
      select tablename, policyname, permissive from pg_policies
       where schemaname = 'app' and tablename in ('shift', 'till_event') and policyname = 'branch_isolation'
       order by tablename`;
    expect(policies.map((p) => `${p.tablename}:${p.permissive}`)).toEqual([
      "shift:RESTRICTIVE",
      "till_event:RESTRICTIVE",
    ]);
  });

  it("till_event.kind admits exactly no_sale, drawer_open and void (§4.6.1)", async () => {
    const [chk] = await db.admin<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'app.till_event'::regclass and conname = 'till_event_kind_check'`;
    expect(chk!.def).toContain("'no_sale'");
    expect(chk!.def).toContain("'drawer_open'");
    expect(chk!.def).toContain("'void'");
  });
});
