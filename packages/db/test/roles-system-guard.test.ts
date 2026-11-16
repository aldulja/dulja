import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenant, type Seed } from "./fixtures";
import { startDb, uuidv7, withTenant, type Db } from "./harness";

// API-03 (2026-11-15 review) — spec:2152: a seeded role's permissions "change only by migration, so a change is a
// reviewed diff". Before 0124 the only database guard on role_permission was forbid_self_grant, which refuses only a
// role the actor holds, so any app_rw session could rewrite a system role every company's people hold. ADR 0091.
describe("0124 — a system role is immutable to app_rw (ADR 0091, API-03)", () => {
  let db: Db;
  let a: Seed;
  let systemRole: string;
  let customRole: string;
  let other: string;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenant(db, "Alpha");
    systemRole = await uuidv7(db.admin);
    customRole = await uuidv7(db.admin);
    other = await uuidv7(db.admin);
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${other}, 'human', ${`other:${a.tenant}`}, 'Other')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${other})`;
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
               values (${systemRole}, ${a.tenant}, 'user', 'User', true)`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${systemRole}, 'admin.audit_log.read')`;
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${customRole}, ${a.tenant}, 'clerk', 'Clerk')`;
    });
  });
  afterAll(async () => db?.stop());

  const asHuman = <T>(fn: (tx: Db["rw"]) => Promise<T>): Promise<T> =>
    withTenant(db.rw, a.tenant, a.human, fn);

  it("refuses app_rw adding a permission to a system role", async () => {
    await expect(
      asHuman(
        (tx) => tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                   values (${a.tenant}, ${systemRole}, 'admin.role.assign')`,
      ),
    ).rejects.toThrow(/ERR_RBAC_SYSTEM_ROLE/);
  });

  it("refuses app_rw removing a permission from a system role", async () => {
    await expect(
      asHuman((tx) => tx`delete from app.role_permission where role_id = ${systemRole}`),
    ).rejects.toThrow(/ERR_RBAC_SYSTEM_ROLE/);
  });

  it("refuses app_rw renaming a system role or flipping is_system", async () => {
    await expect(
      asHuman((tx) => tx`update app.role set name_en = 'Renamed' where id = ${systemRole}`),
    ).rejects.toThrow(/ERR_RBAC_SYSTEM_ROLE/);
    await expect(
      asHuman((tx) => tx`update app.role set is_system = true where id = ${customRole}`),
    ).rejects.toThrow(/ERR_RBAC_SYSTEM_ROLE/);
    await expect(
      asHuman(
        (tx) => tx`insert into app.role (tenant_id, code, name_en, is_system)
                   values (${a.tenant}, 'forged', 'Forged', true)`,
      ),
    ).rejects.toThrow(/ERR_RBAC_SYSTEM_ROLE/);
  });

  it("still lets app_rw edit a custom role", async () => {
    await asHuman(async (tx) => {
      await tx`update app.role set name_en = 'Senior clerk' where id = ${customRole}`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${customRole}, 'admin.audit_log.read')`;
      await tx`delete from app.role_permission where role_id = ${customRole}`;
    });
  });

  it("still lets the migrator, and the system principal (the seed), change a system role", async () => {
    await withTenant(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${systemRole}, 'admin.company.manage')`;
    });
    await withTenant(db.rw, a.tenant, a.system, async (tx) => {
      await tx`delete from app.role_permission
                where role_id = ${systemRole} and permission_code = 'admin.company.manage'`;
    });
    const rows = await db.admin<{ permission_code: string }[]>`
      select permission_code from app.role_permission where role_id = ${systemRole} order by 1`;
    expect(rows.map((row) => row.permission_code)).toEqual(["admin.audit_log.read"]);
  });

  it("still lets app_rw assign a system role (assignment is not a role edit)", async () => {
    await asHuman(
      (tx) => tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
                 values (${a.tenant}, ${other}, ${systemRole}, ${a.company})`,
    );
  });
});
