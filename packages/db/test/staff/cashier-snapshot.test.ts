import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  seedTenant,
  seedBranch,
  seedEmployee,
  seedCashier,
  seedBranchPosPolicy,
  grantCodes,
  type Seed,
} from "../fixtures";
import { readSnapshot, computeSnapshot, findSnapshotDrift } from "../../src/staff/cashier";

let db: Db;
let s: Seed;
let other: Seed; // a second tenant, for the security_invoker case only
let branch: string;
let employee: string;

beforeAll(async () => {
  db = await startDb();
  s = await seedTenant(db, "snap");
  other = await seedTenant(db, "snap-other");
  // `snapshotOf` reads `app.pos_cashier` as `s.human`, and that table carries Form A of
  // `branch_isolation` from Task 5's migration 0068. One company-wide grant (no `branchIds`) keeps the
  // read non-empty — amendment A15's consumer side. Without it every snapshot assertion in this file
  // fails on `row!` being undefined and the failure points at `readSnapshot` rather than at the policy.
  await grantCodes(db, s);
  branch = await seedBranch(db, s, { code: "BR-S" });
  employee = await seedEmployee(db, s, { employeeNumber: "E-S", homeBranchId: branch });
}, 180_000);
afterAll(async () => {
  await db.stop();
});

/** `readSnapshot` takes a `tx` like every repository function (spec:2053); this wraps it once. */
const snapshotOf = (principalId: string) =>
  withTenant(db.rw, s.tenant, s.human, (tx) => readSnapshot(tx, principalId));

/** The tenant's system principal passes every branch_isolation form, so it reads any company's cashier. */
const systemSnapshotOf = (principalId: string) =>
  withTenant(db.rw, s.tenant, s.system, (tx) => readSnapshot(tx, principalId));

/** A fresh human principal with a membership in `s.tenant` and no role yet. */
async function human(label: string): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name)
             values (${id}, 'human', ${"sub-" + id}, ${label})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
  });
  return id;
}

/**
 * Edits `roleId`'s permissions as `actor` the way `PUT /v1/admin/roles/{id}/permissions` does — a
 * two-row INSERT, then a DELETE when `remove` is given — and reports, from INSIDE that transaction, which
 * actor the session holds afterwards, whether the actor can see `cashier`, and who the edit's audit rows
 * name. Each of the three is a way a leaked system actor would show.
 */
async function editRoleAs(
  actor: string,
  roleId: string,
  cashier: string,
  edit: { add: readonly [string, string]; remove?: string },
) {
  return withTenant(db.rw, s.tenant, actor, async (tx) => {
    const [mark] = await tx<
      { seq: string }[]
    >`select coalesce(max(seq), 0)::text as seq from app.audit_log`;
    await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
             values (${s.tenant}, ${roleId}, ${edit.add[0]}), (${s.tenant}, ${roleId}, ${edit.add[1]})`;
    if (edit.remove)
      await tx`delete from app.role_permission where role_id = ${roleId} and permission_code = ${edit.remove}`;
    const [setting] = await tx<
      { actor: string }[]
    >`select current_setting('app.actor_id') as actor`;
    const visible =
      await tx`select principal_id from app.pos_cashier where principal_id = ${cashier}`;
    const audited = await tx<{ actor_id: string }[]>`
      select actor_id from app.audit_log
       where seq > ${mark!.seq}::bigint and table_name = 'role_permission'
         and row_id = any(${[...edit.add, ...(edit.remove ? [edit.remove] : [])].map((code) => `${roleId}/${code}`)}::text[])
       order by seq`;
    return {
      actor: setting!.actor,
      visible: visible.length,
      audited: audited.map((r) => r.actor_id),
    };
  });
}

describe("pos_cashier.snapshot — a projection with one writer (§4.6.3, ADR 0061)", () => {
  it("a new cashier's snapshot holds only the codes their assignment grants, at their branch", async () => {
    await seedBranchPosPolicy(db, s, {
      branchId: branch,
      limits: { maxLineDiscountPct: "0.100000", maxVoidAmount: "40.0000" },
    });
    const p = await seedCashier(db, s, {
      employeeId: employee,
      branchId: branch,
      permissions: ["pos.ticket.sell", "pos.ticket.discount"],
    });
    const snap = await snapshotOf(p);
    expect(snap.codes.toSorted()).toEqual(["pos.ticket.discount", "pos.ticket.sell"]);
    expect(snap.limits.maxLineDiscountPct).toBe("0.100000");
    expect(snap.limits.maxVoidAmount).toBe("40.0000");
    expect(BigInt(snap.revision)).toBeGreaterThan(0n);
  });

  it("granting a code regenerates the snapshot and bumps the revision — by TRIGGER, not by a handler", async () => {
    const e2 = await seedEmployee(db, s, { employeeNumber: "E-S2", homeBranchId: branch });
    const p = await seedCashier(db, s, {
      employeeId: e2,
      branchId: branch,
      permissions: ["pos.ticket.sell"],
    });
    const before = await snapshotOf(p);
    await grantCodes(db, s, {
      codes: ["pos.ticket.void"],
      principalId: p,
      roleCode: "void-role",
      branchIds: [branch],
    });
    const after = await snapshotOf(p);
    expect(after.codes.toSorted()).toEqual(["pos.ticket.sell", "pos.ticket.void"]);
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
  });

  it("editing the branch's limit row regenerates every cashier snapshot at that branch", async () => {
    const e3 = await seedEmployee(db, s, { employeeNumber: "E-S3", homeBranchId: branch });
    const p = await seedCashier(db, s, {
      employeeId: e3,
      branchId: branch,
      permissions: ["pos.ticket.sell"],
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx`update app.branch_pos_policy set max_void_amount = 99.0000 where branch_id = ${branch}`,
    );
    expect((await snapshotOf(p)).limits.maxVoidAmount).toBe("99.0000");
  });

  it("a cashier at a branch with NO policy row gets the closed defaults, never a null limit set", async () => {
    const bare = await seedBranch(db, s, { code: "BR-BARE" });
    const e4 = await seedEmployee(db, s, { employeeNumber: "E-S4", homeBranchId: bare });
    const p = await seedCashier(db, s, {
      employeeId: e4,
      branchId: bare,
      permissions: ["pos.ticket.sell"],
    });
    const snap = await snapshotOf(p);
    expect(snap.limits).toEqual({
      maxLineDiscountPct: "0.000000",
      maxTicketDiscountPct: "0.000000",
      maxVoidAmount: "0.0000",
      maxPriceOverridePct: "0.000000",
      blindReturnAllowed: false,
      maxBlindReturnAmount: "0.0000",
      roundingIncrement: "0.0500",
      requireCustomerOver: null,
      maxCashInDrawer: null,
    });
  });

  it("revoking empties the snapshot's codes — a revoked cashier authorises nothing offline (test 34)", async () => {
    const e5 = await seedEmployee(db, s, { employeeNumber: "E-S5", homeBranchId: branch });
    const p = await seedCashier(db, s, {
      employeeId: e5,
      branchId: branch,
      permissions: ["pos.ticket.sell"],
    });
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx`update app.pos_cashier set revoked_at = now() where principal_id = ${p}`,
    );
    await withTenant(db.rw, s.tenant, s.human, (tx) => tx`select app.refresh_pos_cashier(${p})`);
    expect((await snapshotOf(p)).codes).toEqual([]);
  });

  it("moving an assignment refreshes both the former and new cashier holders", async () => {
    const oldEmployee = await seedEmployee(db, s, {
      employeeNumber: "OLD-HOLDER",
      homeBranchId: branch,
    });
    const newEmployee = await seedEmployee(db, s, {
      employeeNumber: "NEW-HOLDER",
      homeBranchId: branch,
    });
    const oldHolder = await seedCashier(db, s, { employeeId: oldEmployee, branchId: branch });
    const newHolder = await seedCashier(db, s, { employeeId: newEmployee, branchId: branch });
    const role = await grantCodes(db, s, {
      codes: ["pos.ticket.void"],
      principalId: oldHolder,
      roleCode: "MOVE-ASSIGNMENT",
    });
    expect((await snapshotOf(oldHolder)).codes).toEqual(["pos.ticket.void"]);
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) =>
        tx`update app.role_assignment set principal_id=${newHolder} where principal_id=${oldHolder} and role_id=${role} and company_id=${s.company}`,
    );
    expect((await snapshotOf(oldHolder)).codes).toEqual([]);
    expect((await snapshotOf(newHolder)).codes).toEqual(["pos.ticket.void"]);
  });

  it("a role_permission edit by an admin of company X alone refreshes company Y's cashiers (PR 12 review)", async () => {
    // Roles belong to the whole tenant and are edited through the `{ company: "any" }` gate, but
    // `pos_cashier` carries Form A of branch_isolation. Before the PR 12 amendment to ADR 0061 the refresh
    // selected the cashier under the WRITER's RLS, found nothing and returned, so company Y's till kept
    // authorising a code the role had just lost.
    const [companyY, branchTypeY, branchY] = [
      await uuidv7(db.admin),
      await uuidv7(db.admin),
      await uuidv7(db.admin),
    ];
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${companyY}, ${s.tenant}, 'CO-Y', 'Company Y', 'MYR')`;
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en)
               values (${branchTypeY}, ${s.tenant}, ${companyY}, 'BRANCH', 'Branch')`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
               values (${branchY}, ${s.tenant}, ${branchTypeY}, 'Y-HQ', 'Company Y head office')`;
    });
    const y: Seed = { ...s, company: companyY, branchType: branchTypeY, hq: branchY };
    const employeeY = await seedEmployee(db, y, { employeeNumber: "E-Y1", homeBranchId: branchY });
    const cashierY = await seedCashier(db, y, { employeeId: employeeY, branchId: branchY });
    const roleR = await grantCodes(db, y, {
      codes: ["pos.ticket.sell", "pos.ticket.discount"],
      principalId: cashierY,
      roleCode: "SHARED-ROLE-R",
      branchIds: [branchY],
    });
    const before = await systemSnapshotOf(cashierY);
    expect(before.codes).toEqual(["pos.ticket.discount", "pos.ticket.sell"]);

    // adminX may manage roles, holds role R nowhere, and is assigned in company X (s.company) only.
    const adminX = await human("Admin of X");
    await grantCodes(db, s, {
      codes: ["admin.role.manage"],
      principalId: adminX,
      roleCode: "ADMIN-X-ONLY",
    });
    const edit = await editRoleAs(adminX, roleR, cashierY, {
      add: ["pos.ticket.void", "pos.ticket.return"],
      remove: "pos.ticket.discount",
    });
    expect(edit.visible).toBe(0); // the premise: Y's cashier is invisible to the writer, before and after
    expect(edit.actor).toBe(adminX); // the caller's actor is back once the trigger's refresh returns
    expect(edit.audited).toEqual([adminX, adminX, adminX]); // both rows of the INSERT, and the DELETE

    const after = await systemSnapshotOf(cashierY);
    expect(after.codes).toEqual(["pos.ticket.return", "pos.ticket.sell", "pos.ticket.void"]);
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    expect(
      await withTenant(db.rw, s.tenant, s.system, (tx) =>
        findSnapshotDrift(tx, { companyId: companyY }),
      ),
    ).toEqual([]);
  });

  it("the same edit by an admin restricted to one branch refreshes a cashier at another branch", async () => {
    const e7 = await seedEmployee(db, s, { employeeNumber: "E-S7", homeBranchId: branch });
    const cashierB2 = await seedCashier(db, s, { employeeId: e7, branchId: branch });
    const roleR2 = await grantCodes(db, s, {
      codes: ["pos.ticket.sell"],
      principalId: cashierB2,
      roleCode: "SHARED-ROLE-R2",
      branchIds: [branch],
    });
    const before = await systemSnapshotOf(cashierB2);
    expect(before.codes).toEqual(["pos.ticket.sell"]);

    const adminB1 = await human("Admin of HQ only");
    await grantCodes(db, s, {
      codes: ["admin.role.manage"],
      principalId: adminB1,
      roleCode: "ADMIN-HQ-ONLY",
      branchIds: [s.hq],
    });
    const edit = await editRoleAs(adminB1, roleR2, cashierB2, {
      add: ["pos.ticket.void", "pos.ticket.discount"],
    });
    expect(edit.visible).toBe(0);
    expect(edit.actor).toBe(adminB1);
    expect(edit.audited).toEqual([adminB1, adminB1]);

    const after = await systemSnapshotOf(cashierB2);
    expect(after.codes).toEqual(["pos.ticket.discount", "pos.ticket.sell", "pos.ticket.void"]);
    expect(BigInt(after.revision)).toBeGreaterThan(BigInt(before.revision));
    expect(
      await withTenant(db.rw, s.tenant, s.system, (tx) =>
        findSnapshotDrift(tx, { companyId: s.company }),
      ),
    ).toEqual([]);
  });

  it("the refresh refuses to run without a tenant, rather than silently refreshing nothing", async () => {
    const e8 = await seedEmployee(db, s, { employeeNumber: "E-S8", homeBranchId: branch });
    const p = await seedCashier(db, s, { employeeId: e8, branchId: branch });
    await expect(db.rw`select app.refresh_pos_cashier(${p})`).rejects.toThrow(
      /ERR_TENANT_CONTEXT_MISSING/,
    );
  });

  it("computeSnapshot (the job's recomputation) agrees with the stored row for every cashier", async () => {
    const stored = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) =>
        tx<
          { principal_id: string; snapshot: unknown }[]
        >`select principal_id, snapshot from app.pos_cashier order by principal_id`,
    );
    for (const row of stored) {
      const fresh = await withTenant(db.rw, s.tenant, s.system, (tx) =>
        computeSnapshot(tx, row.principal_id),
      );
      expect(fresh).toEqual(row.snapshot);
    }
  });

  it("snapshot->>'revision' is the row's OWN revision, as a string, after every write", async () => {
    // The trap this case exists for: `refresh_pos_cashier`'s UPDATE fires 0065's `catalogue_revision`
    // BEFORE trigger, so any revision the function itself computed would be one behind the row it stored,
    // and the case above would fail for every cashier in the table. `snapshot_revision_stamp` runs second
    // (name order: catalogue_revision < snapshot_revision_stamp) and stamps the value actually stored.
    const e6 = await seedEmployee(db, s, { employeeNumber: "E-S6", homeBranchId: branch });
    const p = await seedCashier(db, s, {
      employeeId: e6,
      branchId: branch,
      permissions: ["pos.ticket.sell"],
    });
    const check = async () => {
      const [row] = await withTenant(
        db.rw,
        s.tenant,
        s.system,
        (tx) => tx<
          { revision: string; snap_revision: string }[]
        >`select revision::text as revision, snapshot->>'revision' as snap_revision
          from app.pos_cashier where principal_id = ${p}`,
      );
      expect(typeof row!.snap_revision).toBe("string"); // never a JSON number: a bigint has no safe one
      expect(row!.snap_revision).toBe(row!.revision);
    };
    await check();
    await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx`update app.pos_cashier set pin_updated_at = now() where principal_id = ${p}`,
    );
    await check(); // a write that is NOT a refresh keeps them equal
  });

  it("who_can_reset_a_pin is evaluated as the READER — a second tenant's manager sees zero rows", async () => {
    // security_invoker = true. Without it the view runs with app_migrator's privileges, and the one object
    // in this slice whose RLS is not the caller's is exactly the object spec:2134 hands to an auditor.
    await grantCodes(db, s, {
      codes: ["pos.cashier.manage_pin"],
      principalId: s.human,
      roleCode: "pin-resetter",
    });
    const mine = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ principal_id: string }[]>`
      select principal_id from app.who_can_reset_a_pin where company_id = ${s.company}`,
    );
    expect(mine.map((r) => r.principal_id)).toContain(s.human);
    const theirs = await withTenant(
      db.rw,
      other.tenant,
      other.human,
      (tx) => tx<{ principal_id: string }[]>`
      select principal_id from app.who_can_reset_a_pin where company_id = ${s.company}`,
    );
    expect(theirs).toHaveLength(0);
  });
  it("the drift audit door refuses humans, missing context and foreign or missing cashier IDs without audit privilege changes", async () => {
    const [cashier] = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) =>
        tx<
          { principal_id: string }[]
        >`select principal_id from app.pos_cashier order by principal_id limit 1`,
    );
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.human,
        (tx) =>
          tx`select app.record_cashier_snapshot_drift(${cashier!.principal_id},'{}'::jsonb,'{}'::jsonb)`,
      ),
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
    await expect(
      db.rw`select app.record_cashier_snapshot_drift(${cashier!.principal_id},'{}'::jsonb,'{}'::jsonb)`,
    ).rejects.toThrow(/ERR_RBAC_FORBIDDEN/);
    await expect(
      withTenant(
        db.rw,
        other.tenant,
        other.system,
        (tx) =>
          tx`select app.record_cashier_snapshot_drift(${cashier!.principal_id},'{}'::jsonb,'{}'::jsonb)`,
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
    const missing = await uuidv7(db.admin);
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        s.system,
        (tx) => tx`select app.record_cashier_snapshot_drift(${missing},'{}'::jsonb,'{}'::jsonb)`,
      ),
    ).rejects.toThrow(/ERR_NOT_FOUND/);
    const [fn] = await db.admin<
      { prosecdef: boolean; owner: string; proconfig: string[] }[]
    >`select p.prosecdef,r.rolname as owner,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='app' and p.proname='record_cashier_snapshot_drift'`;
    expect(fn).toEqual({
      prosecdef: true,
      owner: "app_migrator",
      proconfig: ["search_path=app, pg_temp"],
    });
    const [privilege] = await db.admin<
      { direct_insert: boolean; public_exec: boolean; rw_exec: boolean }[]
    >`select has_table_privilege('app_rw','app.audit_log','INSERT') as direct_insert, exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) acl where n.nspname='app' and p.proname='record_cashier_snapshot_drift' and acl.grantee=0 and acl.privilege_type='EXECUTE') as public_exec,has_function_privilege('app_rw','app.record_cashier_snapshot_drift(uuid,jsonb,jsonb)','EXECUTE') as rw_exec`;
    expect(privilege).toEqual({ direct_insert: false, public_exec: false, rw_exec: true });
  });
});
