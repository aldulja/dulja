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

// 8C T10 — migration 0093, the termination trigger (spec:2090, spec:1324; ADR 0078). Every termination below is a
// DIRECT app_rw UPDATE of `employee.terminated_on`: spec:2090 names that path, and a trigger is what no writer bypasses.

let db: Db;
let s: Seed;
let branchB: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenantV2(db, "Termination");
  // **The terminating actor needs a role assignment, or every case here passes vacuously** (Global Constraint 21(b)):
  // app.employee carries Form A′ and app.pos_cashier Form A of branch_isolation, both RESTRICTIVE, and seedTenant
  // grants s.human nothing — the UPDATE would match zero rows and raise nothing.
  await grantCodes(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
  branchB = await seedBranch(db, s, { code: "TB2", nameEn: "Termination branch two" });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** A human principal with a membership and nothing else — the login half of a staff member. */
async function principal(label: string): Promise<string> {
  const principalId = await uuidv7(db.admin);
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${principalId}, 'human', ${`test:termination:${principalId}`}, ${label})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
  });
  return principalId;
}

/** An employee with all three doors: a login principal, a till credential carrying a pos code at `cashierBranch`,
 *  and a company-wide role. */
async function staffMember(
  employeeNumber: string,
  cashierBranch = s.hq,
): Promise<{ employeeId: string; principalId: string }> {
  const principalId = await principal(employeeNumber);
  const employeeId = await seedEmployee(db, s, { employeeNumber, principalId });
  await seedCashier(db, s, {
    employeeId,
    branchId: cashierBranch,
    principalId,
    pin: "246810",
    permissions: ["pos.ticket.sell"],
  });
  await grantCodes(db, s, {
    codes: ["hr.employee.read"],
    principalId,
    roleCode: `r-${employeeNumber}`,
  });
  return { employeeId, principalId };
}

const terminate = (employeeId: string, on = "2026-01-20", actor = s.human) =>
  withTenant(
    db.rw,
    s.tenant,
    actor,
    (tx) => tx`update app.employee set terminated_on = ${on} where id = ${employeeId}`,
  );
const cashierOf = async (principalId: string) =>
  (
    await db.admin<
      { revoked_at: string | null; snapshot: { codes?: string[] }; revision: string }[]
    >`
      select revoked_at::text as revoked_at, snapshot, revision::text as revision
        from app.pos_cashier where principal_id = ${principalId}`
  )[0]!;
const assignmentsOf = (principalId: string) =>
  db.admin<{ expires_at: string | null }[]>`
    select expires_at::text as expires_at from app.role_assignment where principal_id = ${principalId}`;

describe("app.terminate_employee (spec:2090, spec:1324; acceptance test 34)", () => {
  it("revokes the cashier, expires every role assignment and empties the snapshot — in ONE transaction", async () => {
    const { employeeId, principalId } = await staffMember("T-1");
    expect((await cashierOf(principalId)).snapshot.codes).toEqual(["pos.ticket.sell"]);
    const live = await assignmentsOf(principalId);
    expect(live).toHaveLength(2); // the cashier's branch role and the company-wide one
    expect(live.every((a) => a.expires_at === null)).toBe(true);

    const result = await terminate(employeeId);
    expect(result.count).toBe(1); // the row was visible: the trigger really fired

    const cashier = await cashierOf(principalId);
    expect(cashier.revoked_at).not.toBeNull();
    expect(cashier.snapshot.codes).toEqual([]);
    const expired = await assignmentsOf(principalId);
    expect(expired).toHaveLength(2); // expired, never deleted (spec:2049)
    for (const a of expired) expect(a.expires_at).not.toBeNull();
  });

  it("writes the catalogue tombstone at the bumped revision (6C's own trigger, not a second one)", async () => {
    const { employeeId, principalId } = await staffMember("T-2");
    const before = (await cashierOf(principalId)).revision;
    await terminate(employeeId);
    const tombs = await db.admin<{ stream: string; revision: string }[]>`
      select stream, revision::text as revision from app.catalogue_tombstone where row_id = ${principalId}`;
    expect(tombs).toHaveLength(1);
    expect(tombs[0]!.stream).toBe("cashier");
    const after = await cashierOf(principalId);
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before));
    // The revocation is the row's LAST write (0093 expires the assignments first, so 6C's snapshot refreshes come
    // before it): the tombstone carries the row's final revision, and the snapshot names it too.
    expect(tombs[0]!.revision).toBe(after.revision);
    const [stamped] = await db.admin<{ revision: string }[]>`
      select snapshot->>'revision' as revision from app.pos_cashier where principal_id = ${principalId}`;
    expect(stamped!.revision).toBe(after.revision);
  });

  it("drops the row out of app.pos_cashier_sync, so the till stops receiving it", async () => {
    const { employeeId, principalId } = await staffMember("T-3");
    const sync = () =>
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) => tx<{ id: string }[]>`select id from app.pos_cashier_sync(${s.company}, ${s.hq}, 0)`,
      );
    expect((await sync()).map((r) => r.id)).toContain(principalId);
    await terminate(employeeId);
    expect((await sync()).map((r) => r.id)).not.toContain(principalId);
  });

  it("revokes a credential at a branch the terminating actor cannot see", async () => {
    // The actor holds hr.employee.manage at the employee's HOME branch only; the till credential is at branch B.
    // Under the actor's own RLS the revoke would match nothing and leave a live credential for a terminated
    // employee, so 0093 writes `revoked_at` as the tenant's system principal (ADR 0061's refresh precedent).
    const { employeeId, principalId } = await staffMember("T-4", branchB);
    const clerk = await principal("Branch HR clerk");
    await grantCodes(db, s, {
      codes: ["hr.employee.manage", "hr.employee.read"],
      principalId: clerk,
      roleCode: "r-branch-hr",
      branchIds: [s.hq],
    });
    const hidden = await withTenant(
      db.rw,
      s.tenant,
      clerk,
      (tx) => tx`select 1 from app.pos_cashier where principal_id = ${principalId}`,
    );
    expect(hidden).toHaveLength(0); // the precondition: the clerk really cannot see it
    const result = await terminate(employeeId, "2026-01-20", clerk);
    expect(result.count).toBe(1);
    expect((await cashierOf(principalId)).revoked_at).not.toBeNull();
    // ...and the actor is restored afterwards: the role-assignment expiry is the CLERK's in the audit chain.
    const [audit] = await db.admin<{ actor_id: string }[]>`
      select actor_id from app.audit_log
       where tenant_id = ${s.tenant} and table_name = 'role_assignment'
         and after->>'principal_id' = ${principalId} and action = 'update'
       order by seq desc limit 1`;
    expect(audit!.actor_id).toBe(clerk);
  });

  it("is idempotent: a corrected date fires nothing — the FIRST revocation stands and no second tombstone", async () => {
    const { employeeId, principalId } = await staffMember("T-5");
    await terminate(employeeId, "2026-01-20");
    const first = await cashierOf(principalId);
    await terminate(employeeId, "2026-01-25");
    const second = await cashierOf(principalId);
    expect(second.revoked_at).toBe(first.revoked_at);
    expect(second.revision).toBe(first.revision);
  });

  it("does nothing when terminated_on is CLEARED: a reinstatement is an explicit act, not a side effect", async () => {
    const { employeeId, principalId } = await staffMember("T-6");
    await terminate(employeeId);
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.employee set terminated_on = null where id = ${employeeId}`,
    );
    expect((await cashierOf(principalId)).revoked_at).not.toBeNull();
    for (const a of await assignmentsOf(principalId)) expect(a.expires_at).not.toBeNull();
  });

  it("an employee with NO principal terminates cleanly (most staff never log in — spec:2097)", async () => {
    const employeeId = await seedEmployee(db, s, { employeeNumber: "T-7" });
    const result = await terminate(employeeId);
    expect(result.count).toBe(1);
  });

  it("a credential whose principal is not the employee's login is revoked and its assignments expire too", async () => {
    // seedCashier mints its own principal when none is given: the employee row has no principal_id at all.
    const employeeId = await seedEmployee(db, s, { employeeNumber: "T-9" });
    const cashierPrincipal = await seedCashier(db, s, {
      employeeId,
      branchId: s.hq,
      pin: "135790",
      permissions: ["pos.ticket.sell"],
    });
    await terminate(employeeId);
    const cashier = await cashierOf(cashierPrincipal);
    expect(cashier.revoked_at).not.toBeNull();
    expect(cashier.snapshot.codes).toEqual([]);
    for (const a of await assignmentsOf(cashierPrincipal)) expect(a.expires_at).not.toBeNull();
  });

  it("terminating the tenant's LAST administrator is refused ERR_RBAC_LAST_ADMIN and nothing is written", async () => {
    // The assignments expire as the terminating actor, so Plan 0A's guard holds: appoint a successor first.
    const { employeeId, principalId } = await staffMember("T-10");
    await grantCodes(db, s, {
      codes: ["admin.user.manage"],
      principalId,
      roleCode: "r-last-admin",
    });
    await expect(terminate(employeeId)).rejects.toThrow(/ERR_RBAC_LAST_ADMIN/);
    const [employee] = await db.admin<{ terminated_on: string | null }[]>`
      select terminated_on::text as terminated_on from app.employee where id = ${employeeId}`;
    expect(employee!.terminated_on).toBeNull();
    expect((await cashierOf(principalId)).revoked_at).toBeNull();
    for (const a of await assignmentsOf(principalId)) expect(a.expires_at).toBeNull();
  });

  it("R4 still holds: a principal cannot terminate THEMSELVES (8A's guard runs first, unchanged)", async () => {
    const { employeeId, principalId } = await staffMember("T-8");
    await expect(terminate(employeeId, "2026-01-20", principalId)).rejects.toThrow(
      /ERR_HR_SELF_PAY/,
    );
    expect((await cashierOf(principalId)).revoked_at).toBeNull();
  });

  it("is SECURITY INVOKER with no parameter, so it runs as — and can only run as — the terminating actor", async () => {
    const [fn] = await db.admin<{ nargs: number; security_definer: boolean }[]>`
      select pronargs::int as nargs, prosecdef as security_definer
        from pg_proc where oid = 'app.terminate_employee'::regproc`;
    expect(fn).toEqual({ nargs: 0, security_definer: false });
  });
});
