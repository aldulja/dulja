import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { startDb, type Db, uuidv7, withTenant } from "./harness";

interface Tenant {
  id: string;
  system: string;
  human: string;
  company: string;
}

async function bootstrapTenant(db: Db, name: string): Promise<Tenant> {
  const tenant: Tenant = {
    id: await uuidv7(db.admin),
    system: await uuidv7(db.admin),
    human: await uuidv7(db.admin),
    company: await uuidv7(db.admin),
  };
  await withTenant(db.migrator, tenant.id, tenant.system, async (tx) => {
    await tx`insert into app.tenant (id, name) values (${tenant.id}, ${name})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${tenant.system}, 'system', ${`system:${tenant.id}`}, 'system')`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${tenant.id}, ${tenant.system})`;
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${tenant.human}, 'human', ${`human:${tenant.id}`}, ${`${name} owner`})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${tenant.id}, ${tenant.human})`;
    // Before the company, for the reason fixtures.ts:43 gives: 0008 made company.base_currency a foreign
    // key, so a tenant defines its base currency before it has a company to denominate.
    await tx`insert into app.currency (tenant_id, code, name_en) values (${tenant.id}, 'MYR', 'MYR')`;
    await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${tenant.company}, ${tenant.id}, 'HQ', ${`${name} HQ`}, 'MYR')`;
  });
  return tenant;
}

const peopleWithPermission = (tx: Sql, companyId: string) => tx<
  { id: string; display_name: string }[]
>`
  select distinct p.id, p.display_name
    from app.principal p
    join app.role_assignment ra on ra.principal_id = p.id
    join app.role_permission rp on rp.role_id = ra.role_id
   where ra.company_id = ${companyId} and rp.permission_code = 'accounting.purchase.post'
     and (ra.expires_at is null or ra.expires_at > now())
   order by p.display_name`;

describe("tenant isolation and RBAC — spec §3.8, §4.1, §4.2; acceptance tests 12 and 14", () => {
  let db: Db;
  let a: Tenant;
  let b: Tenant;

  beforeAll(async () => {
    db = await startDb();
    a = await bootstrapTenant(db, "Alpha");
    b = await bootstrapTenant(db, "Beta");
    await db.migrator`insert into app.permission (code, module, mutating, description) values
      ('accounting.purchase.post', 'accounting', true, 'Post a purchase document'),
      ('accounting.sales.post',    'accounting', true, 'Post a sales document'),
      ('admin.user.manage',        'admin',      true, 'Manage users')
      on conflict (code) do nothing`;
  });

  afterAll(async () => {
    await db.stop();
  });

  it("both tenants may use company code HQ; each sees only its own company", async () => {
    const seen = async (tenant: Tenant) =>
      withTenant(db.rw, tenant.id, tenant.human, async (tx) =>
        (await tx<{ id: string }[]>`select id from app.company`).map((row) => row.id),
      );
    expect(await seen(a)).toEqual([a.company]);
    expect(await seen(b)).toEqual([b.company]);
  });

  it("a write carrying another tenant's id is rejected by the policy, not by application code", async () => {
    await expect(
      withTenant(
        db.rw,
        a.id,
        a.human,
        (tx) =>
          tx`insert into app.company (tenant_id, code, name, base_currency) values (${b.id}, 'X', 'Forged', 'MYR')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("an update that would move a row to another tenant is rejected", async () => {
    await expect(
      withTenant(
        db.rw,
        a.id,
        a.human,
        (tx) => tx`update app.company set tenant_id = ${b.id} where id = ${a.company}`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("acceptance test 14: who can post a purchase return in company X is one query", async () => {
    const roleId = await uuidv7(db.admin);
    await withTenant(db.rw, a.id, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'ACCOUNTANT', 'Accountant')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'accounting.purchase.post')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${roleId}, ${a.company})`;
    });
    expect(
      await withTenant(db.rw, a.id, a.system, (tx) => peopleWithPermission(tx, a.company)),
    ).toEqual([{ id: a.human, display_name: "Alpha owner" }]);
    expect(
      await withTenant(db.rw, b.id, b.system, (tx) => peopleWithPermission(tx, a.company)),
    ).toEqual([]);
  });

  it("a role_permission must name a catalogued permission", async () => {
    const roleId = await uuidv7(db.admin);
    await expect(
      withTenant(db.rw, a.id, a.system, async (tx) => {
        await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'BAD', 'Bad')`;
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'does.not.exist')`;
      }),
    ).rejects.toThrow(/foreign key/);
  });

  it("fiscal periods cannot overlap within a company", async () => {
    await withTenant(
      db.rw,
      a.id,
      a.system,
      (tx) =>
        tx`insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on) values (${a.id}, ${a.company}, '2026-01-01', '2026-01-31')`,
    );
    await expect(
      withTenant(
        db.rw,
        a.id,
        a.system,
        (tx) =>
          tx`insert into app.fiscal_period (tenant_id, company_id, starts_on, ends_on) values (${a.id}, ${a.company}, '2026-01-15', '2026-02-14')`,
      ),
    ).rejects.toThrow(/exclusion constraint/);
  });

  it("account codes are unique per company and an account can be archived", async () => {
    const accountId = await uuidv7(db.admin);
    await withTenant(db.rw, a.id, a.system, async (tx) => {
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type) values (${accountId}, ${a.id}, ${a.company}, '1000', 'Cash', 'asset')`;
    });
    await expect(
      withTenant(
        db.rw,
        a.id,
        a.system,
        (tx) =>
          tx`insert into app.account (tenant_id, company_id, code, name_en, type) values (${a.id}, ${a.company}, '1000', 'Dup', 'asset')`,
      ),
    ).rejects.toThrow(/unique/);
    await withTenant(
      db.rw,
      a.id,
      a.system,
      (tx) => tx`update app.account set archived_at = now() where id = ${accountId}`,
    );
    const [row] = await withTenant(
      db.rw,
      a.id,
      a.system,
      (tx) =>
        tx<
          { archived: boolean }[]
        >`select archived_at is not null as archived from app.account where id = ${accountId}`,
    );
    expect(row!.archived).toBe(true);
  });

  it("actor_has(): company-wide, branch-restricted and expired assignments (spec §4.2.1)", async () => {
    const roleId = await uuidv7(db.admin);
    const p2 = await uuidv7(db.admin);
    const branchTypeId = await uuidv7(db.admin);
    const branchOne = await uuidv7(db.admin);
    const branchTwo = await uuidv7(db.admin);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${p2}, 'human', ${`human2:${a.id}`}, 'Branch manager')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.id}, ${p2})`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'BRANCH_MANAGER', 'Branch manager')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'accounting.sales.post')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${p2}, ${roleId}, ${a.company})`;
    });
    expect(
      await withTenant(
        db.rw,
        a.id,
        p2,
        (tx) =>
          tx<
            { ok: boolean }[]
          >`select app.actor_has('accounting.sales.post', ${a.company}, ${branchOne}) as ok`,
      ),
    ).toEqual([{ ok: true }]);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en) values (${branchTypeId}, ${a.id}, ${a.company}, 'BRANCH', 'Branch')`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en) values
        (${branchOne}, ${a.id}, ${branchTypeId}, 'KL01', 'Kuala Lumpur 1'),
        (${branchTwo}, ${a.id}, ${branchTypeId}, 'JB01', 'Johor Bahru 1')`;
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id) values (${a.id}, ${p2}, ${roleId}, ${a.company}, ${branchOne})`;
    });
    const check = (branch: string) =>
      withTenant(
        db.rw,
        a.id,
        p2,
        (tx) =>
          tx<
            { ok: boolean }[]
          >`select app.actor_has('accounting.sales.post', ${a.company}, ${branch}) as ok`,
      );
    expect(await check(branchOne)).toEqual([{ ok: true }]);
    expect(await check(branchTwo)).toEqual([{ ok: false }]);
    expect(
      await withTenant(
        db.rw,
        a.id,
        p2,
        (tx) =>
          tx<
            { ok: boolean }[]
          >`select app.actor_has('accounting.sales.post', ${a.company}, null) as ok`,
      ),
    ).toEqual([{ ok: false }]);
    expect(
      await withTenant(
        db.rw,
        a.id,
        a.system,
        (tx) =>
          tx<
            { ok: boolean }[]
          >`select app.actor_has('accounting.sales.post', ${a.company}, ${branchTwo}) as ok`,
      ),
    ).toEqual([{ ok: true }]);
    await withTenant(
      db.migrator,
      a.id,
      a.system,
      (tx) =>
        tx`update app.role_assignment set expires_at = now() - interval '1 minute' where principal_id = ${p2}`,
    );
    expect(await check(branchOne)).toEqual([{ ok: false }]);
  });

  it("no self-grant: a principal cannot assign a role to themselves or change a role they hold", async () => {
    const roleId = await uuidv7(db.admin);
    await withTenant(
      db.migrator,
      a.id,
      a.system,
      (tx) =>
        tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.id}, 'SELFTEST', 'Self test')`,
    );
    await expect(
      withTenant(
        db.rw,
        a.id,
        a.human,
        (tx) =>
          tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${roleId}, ${a.company})`,
      ),
    ).rejects.toThrow(/ERR_RBAC_SELF_GRANT/);
    await withTenant(
      db.migrator,
      a.id,
      a.system,
      (tx) =>
        tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${roleId}, ${a.company})`,
    );
    await expect(
      withTenant(
        db.rw,
        a.id,
        a.human,
        (tx) =>
          tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${roleId}, 'accounting.purchase.post')`,
      ),
    ).rejects.toThrow(/ERR_RBAC_SELF_ESCALATION/);
  });

  it("kind discipline: terminals hold only pos_terminal, humans never do, the system principal holds nothing", async () => {
    const terminal = await uuidv7(db.admin);
    const posRole = await uuidv7(db.admin);
    const clerkRole = await uuidv7(db.admin);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${terminal}, 'terminal', ${`terminal:${terminal}`}, 'Till 1')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.id}, ${terminal})`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${posRole}, ${a.id}, 'pos_terminal', 'POS terminal'), (${clerkRole}, ${a.id}, 'user', 'User')`;
    });
    const assign = (principalId: string, roleId: string) =>
      withTenant(
        db.migrator,
        a.id,
        a.system,
        (tx) =>
          tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${principalId}, ${roleId}, ${a.company})`,
      );
    await expect(assign(terminal, clerkRole)).rejects.toThrow(/ERR_RBAC_KIND/);
    await expect(assign(a.human, posRole)).rejects.toThrow(/ERR_RBAC_KIND/);
    await expect(
      withTenant(
        db.migrator,
        a.id,
        a.human,
        (tx) =>
          tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.system}, ${clerkRole}, ${a.company})`,
      ),
    ).rejects.toThrow(/ERR_RBAC_KIND/);
    await assign(terminal, posRole);
  });

  it("the last administrator cannot be expired or stripped", async () => {
    const adminRole = await uuidv7(db.admin);
    const p2 = await uuidv7(db.admin);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${adminRole}, ${a.id}, 'admin', 'Administrator')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${a.id}, ${adminRole}, 'admin.user.manage')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${a.human}, ${adminRole}, ${a.company})`;
    });
    await expect(
      withTenant(
        db.migrator,
        a.id,
        a.system,
        (tx) =>
          tx`update app.role_assignment set expires_at = now() where principal_id = ${a.human} and role_id = ${adminRole}`,
      ),
    ).rejects.toThrow(/ERR_RBAC_LAST_ADMIN/);
    await expect(
      withTenant(
        db.migrator,
        a.id,
        a.system,
        (tx) =>
          tx`delete from app.role_permission where role_id = ${adminRole} and permission_code = 'admin.user.manage'`,
      ),
    ).rejects.toThrow(/ERR_RBAC_LAST_ADMIN/);
    await expect(
      withTenant(
        db.migrator,
        a.id,
        a.system,
        (tx) =>
          tx`update app.role_permission set permission_code = 'accounting.sales.post' where role_id = ${adminRole} and permission_code = 'admin.user.manage'`,
      ),
    ).rejects.toThrow(/ERR_RBAC_LAST_ADMIN/);
    await withTenant(db.migrator, a.id, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${p2}, 'human', ${`human3:${a.id}`}, 'Second admin')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.id}, ${p2})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${a.id}, ${p2}, ${adminRole}, ${a.company})`;
      await tx`update app.role_assignment set expires_at = now() where principal_id = ${a.human} and role_id = ${adminRole}`;
    });
  });
});
