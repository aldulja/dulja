import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  grantCodes,
  seedBranch,
  seedCashier,
  seedEmployee,
  seedTenantV2,
  type Seed,
} from "../fixtures";

// 8C T11 — migration 0094, "cashiers are employees" (spec:2090, spec:1324; ADR 0078 decision 5): an unrevoked
// `pos_cashier` must reference an employee with `terminated_on IS NULL`, enforced by a DEFERRABLE INITIALLY DEFERRED
// constraint trigger on both tables.

let db: Db;
let s: Seed;
let branchB: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Cashier is employee");
  // **The grant is the first line, or cases 1 and 2 fail as "resolved instead of rejecting" for the wrong reason**
  // (Global Constraint 21(a)/(b)): s.human sees no employee and no pos_cashier row through the RESTRICTIVE
  // branch_isolation forms without a live role assignment, so the UPDATEs below would match zero rows.
  await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
  branchB = await seedBranch(db, s, { code: "CB2", nameEn: "Cashier branch two" });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** A human principal with a membership and nothing else — Task 10's helper, repeated (§3.7.1: each file owns its db). */
async function principal(label: string): Promise<string> {
  const principalId = await uuidv7(db.admin);
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${principalId}, 'human', ${`test:cashier-is-employee:${principalId}`}, ${label})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
  });
  return principalId;
}

/** An employee with a login principal, a till credential at `cashierBranch` and a company-wide role. */
async function staffMember(
  employeeNumber: string,
  opts: { homeBranchId?: string; cashierBranch?: string } = {},
): Promise<{ employeeId: string; principalId: string }> {
  const principalId = await principal(employeeNumber);
  const employeeId = await seedEmployee(db, s, {
    employeeNumber,
    principalId,
    ...(opts.homeBranchId === undefined ? {} : { homeBranchId: opts.homeBranchId }),
  });
  await seedCashier(db, s, {
    employeeId,
    branchId: opts.cashierBranch ?? s.hq,
    principalId,
    pin: "123456",
  });
  await grantCodes(db, s, {
    codes: ["hr.employee.read"],
    principalId,
    roleCode: `r-${employeeNumber}`,
  });
  return { employeeId, principalId };
}

const terminate = (employeeId: string, actor = s.human) =>
  withTenant(
    db.rw,
    s.tenant,
    actor,
    (tx) => tx`update app.employee set terminated_on = '2026-01-20' where id = ${employeeId}`,
  );
const unrevoke = (principalId: string, actor = s.human) =>
  withTenant(
    db.rw,
    s.tenant,
    actor,
    (tx) => tx`update app.pos_cashier set revoked_at = null where principal_id = ${principalId}`,
  );
const revokedAt = async (principalId: string) =>
  (
    await db.admin<{ revoked_at: string | null }[]>`
      select revoked_at::text as revoked_at from app.pos_cashier where principal_id = ${principalId}`
  )[0]!.revoked_at;

describe("app.assert_cashier_is_employee (spec:2090, deferrable — both sides)", () => {
  it("refuses a NEW cashier for an already-terminated employee, at COMMIT", async () => {
    // principal("C-1") and not staffMember("C-1"): this employee must have NO credential yet, because the
    // seedCashier below is what the constraint refuses.
    const employeeId = await seedEmployee(db, s, {
      employeeNumber: "C-1",
      principalId: await principal("C-1"),
    });
    const result = await terminate(employeeId);
    expect(result.count).toBe(1); // the row was visible: the termination really happened
    await expect(seedCashier(db, s, { employeeId, branchId: s.hq, pin: "123456" })).rejects.toThrow(
      /ERR_HR_CASHIER_NOT_EMPLOYEE: cashier .* references terminated employee C-1/,
    );
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.pos_cashier where employee_id = ${employeeId}`;
    expect(n!.n).toBe(0); // the whole transaction rolled back
  });

  it("refuses UN-revoking a cashier whose employee is terminated", async () => {
    const { employeeId, principalId } = await staffMember("C-2");
    await terminate(employeeId);
    expect(await revokedAt(principalId)).not.toBeNull();
    await expect(unrevoke(principalId)).rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
    expect(await revokedAt(principalId)).not.toBeNull();
  });

  it("ADMITS the termination path itself, because the constraint is DEFERRED to COMMIT", async () => {
    // Inside one transaction 0093 writes terminated_on BEFORE it revokes the credential; an immediate constraint
    // would see the intermediate state and abort the very path spec:2090 mandates.
    const { employeeId, principalId } = await staffMember("C-3");
    const result = await terminate(employeeId);
    expect(result.count).toBe(1);
    expect(await revokedAt(principalId)).not.toBeNull();
  });

  it("admits a REVOKED cashier pointing at a terminated employee — that is the post-termination state", async () => {
    const [row] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.pos_cashier c join app.employee e on e.id = c.employee_id
       where c.tenant_id = ${s.tenant} and c.revoked_at is not null and e.terminated_on is not null`;
    expect(row!.n).toBeGreaterThan(0);
  });

  it("checks the state at COMMIT, not at the statement: a violation repaired in the same transaction passes", async () => {
    const { employeeId, principalId } = await staffMember("C-4");
    await terminate(employeeId);
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`update app.pos_cashier set revoked_at = null where principal_id = ${principalId}`;
      // ...violating here, and repaired before COMMIT by reinstating the employee in the same transaction.
      await tx`update app.employee set terminated_on = null where id = ${employeeId}`;
    });
    expect(await revokedAt(principalId)).toBeNull();
  });

  it("admits restoring a credential once the employee is reinstated (a reinstatement is an explicit act)", async () => {
    const { employeeId, principalId } = await staffMember("C-5");
    await terminate(employeeId);
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.employee set terminated_on = null where id = ${employeeId}`,
    );
    await unrevoke(principalId);
    expect(await revokedAt(principalId)).toBeNull();
  });

  it("refuses a branch-restricted actor who can see the CREDENTIAL but not the EMPLOYEE", async () => {
    // The employee's home branch is B and the credential is at HQ; the clerk holds HQ only. Under the clerk's own
    // RLS the join to app.employee finds nothing (Form A′ on home_branch_id), and a check that read as the actor
    // would pass vacuously — the fail-open shape. 0094 reads as the tenant's system principal, like 0093.
    const { employeeId, principalId } = await staffMember("C-6", {
      homeBranchId: branchB,
      cashierBranch: s.hq,
    });
    await terminate(employeeId);
    const clerk = await principal("HQ till clerk");
    await grantCodes(db, s, {
      codes: ["hr.employee.manage", "hr.employee.read"],
      principalId: clerk,
      roleCode: "r-hq-clerk",
      branchIds: [s.hq],
    });
    const seen = await withTenant(db.rw, s.tenant, clerk, async (tx) => ({
      cashier: await tx`select 1 from app.pos_cashier where principal_id = ${principalId}`,
      employee: await tx`select 1 from app.employee where id = ${employeeId}`,
    }));
    expect(seen.cashier).toHaveLength(1); // the precondition: the credential is visible...
    expect(seen.employee).toHaveLength(0); // ...and the employee is not
    await expect(unrevoke(principalId, clerk)).rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
    expect(await revokedAt(principalId)).not.toBeNull();
  });

  it("restores the caller's actor after its check, so later writes in the transaction stay attributed", async () => {
    const { principalId } = await staffMember("C-7");
    const actor = await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      // a live credential written again (revoked_at is a column the trigger watches) queues the check
      await tx`update app.pos_cashier set revoked_at = null where principal_id = ${principalId}`;
      await tx`set constraints all immediate`; // run the deferred check now, inside the transaction
      const [row] = await tx<
        { actor: string }[]
      >`select current_setting('app.actor_id', true) as actor`;
      return row!.actor;
    });
    expect(actor).toBe(s.human);
  });

  it("both triggers are constraint triggers, DEFERRABLE INITIALLY DEFERRED (spec:2090)", async () => {
    const rows = await db.admin<
      { table: string; name: string; deferrable: boolean; deferred: boolean }[]
    >`
      select c.relname as table, t.tgname as name, t.tgdeferrable as deferrable, t.tginitdeferred as deferred
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgfoid = 'app.assert_cashier_is_employee'::regproc
       order by c.relname`;
    expect(rows).toEqual([
      {
        table: "employee",
        name: "employee_cashier_still_employed",
        deferrable: true,
        deferred: true,
      },
      { table: "pos_cashier", name: "pos_cashier_is_employee", deferrable: true, deferred: true },
    ]);
  });
});
