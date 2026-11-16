import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

const problem = async (response: Response): Promise<Problem> => (await response.json()) as Problem;

describe("/v1/companies/{companyId}/role-assignments — spec:2049, 2166, 2179 R5/R8", () => {
  let api: StartedApi;
  let a: Seed;
  let clerkRole: string;
  let invited: string;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    const adminRole = await uuidv7(api.db.admin);
    clerkRole = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system) values
        (${adminRole}, ${a.tenant}, 'admin', 'Administrator', true),
        (${clerkRole}, ${a.tenant}, 'clerk', 'Clerk', true)`;
      for (const code of ["admin.user.manage", "admin.role.assign"])
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${a.tenant}, ${adminRole}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${adminRole}, ${a.company})`;
    });
    invited = (
      (await (
        await api.request({
          method: "POST",
          path: "/v1/admin/users",
          as: a.human,
          body: { email: "clerk@example.test", displayName: "Clerk" },
        })
      ).json()) as { id: string }
    ).id;
  });
  afterAll(async () => api.stop());

  it("assigns a role in a company, with branch rows, and lists it back", async () => {
    const response = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/role-assignments`,
      as: a.human,
      body: { principalId: invited, roleId: clerkRole, branchIds: [a.hq] },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      principalId: invited,
      roleId: clerkRole,
      companyId: a.company,
      branchIds: [a.hq],
      grantedBy: a.human,
      expiresAt: null,
    });

    const list = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/role-assignments?principalId=${invited}`,
      as: a.human,
    });
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("grantedBy is stamped from the session, not from the body (SAH-044)", async () => {
    const [row] = await api.db.admin<{ granted_by: string }[]>`
      select granted_by from app.role_assignment
       where principal_id = ${invited} and role_id = ${clerkRole}`;
    expect(row!.granted_by).toBe(a.human);
  });

  it("a principal cannot change their own assignments (spec:2179 R5)", async () => {
    const response = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/role-assignments`,
      as: a.human,
      body: { principalId: a.human, roleId: clerkRole },
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("ERR_RBAC_SELF_GRANT");
  });

  it("replacing the branch rows narrows the assignment; an empty list means every branch", async () => {
    const narrowed = await api.request({
      method: "PUT",
      path: `/v1/companies/${a.company}/role-assignments/${invited}/${clerkRole}/branches`,
      as: a.human,
      body: { branchIds: [] },
    });
    expect(narrowed.status).toBe(200);
    expect(await narrowed.json()).toMatchObject({ branchIds: [] });
    const [row] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment_branch
       where principal_id = ${invited} and role_id = ${clerkRole}`;
    expect(row!.n).toBe(0);
  });

  it("refuses a branch id that is not a live BRANCH value of this company — 404, never a leak", async () => {
    // A cost-centre value of THIS company, and the head office of ANOTHER tenant: the tenant-wide FK admits
    // both, and `actor_has(code, company, branch)` would answer true for a document carrying either id.
    const costCentreType = await uuidv7(api.db.admin);
    const costCentre = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.dimension_type (id, tenant_id, company_id, code, name_en)
               values (${costCentreType}, ${a.tenant}, ${a.company}, 'COST_CENTRE', 'Cost centre')`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
               values (${costCentre}, ${a.tenant}, ${costCentreType}, 'NORTH', 'North')`;
    });
    const other = await seedTenant(api.db, "Gamma");
    for (const branchId of [costCentre, other.hq]) {
      const res = await api.request({
        method: "PUT",
        path: `/v1/companies/${a.company}/role-assignments/${invited}/${clerkRole}/branches`,
        as: a.human,
        body: { branchIds: [a.hq, branchId] },
      });
      expect(res.status, branchId).toBe(404);
      expect((await problem(res)).code).toBe("ERR_NOT_FOUND");
    }
    // Nothing half-written: the assignment still has the rows it had.
    const [row] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment_branch
       where principal_id = ${invited} and role_id = ${clerkRole} and branch_id <> ${a.hq}`;
    expect(row!.n).toBe(0);
  });

  it("pages with the shared cursor codec — every assignment is reachable (§4.2.8)", async () => {
    // Three more clerks, four assignments in all; pages of two must cover them with no repeat and no gap.
    const seen: string[] = [];
    for (const label of ["p1", "p2", "p3"]) {
      const created = await api.request({
        method: "POST",
        path: "/v1/admin/users",
        as: a.human,
        body: { email: `${label}@example.test`, displayName: label },
      });
      const { id } = (await created.json()) as { id: string };
      const assigned = await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/role-assignments`,
        as: a.human,
        body: { principalId: id, roleId: clerkRole },
      });
      expect(assigned.status).toBe(201);
    }
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await api.request({
        method: "GET",
        path: `/v1/companies/${a.company}/role-assignments?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        as: a.human,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { principalId: string; roleId: string }[];
        next_cursor: string | null;
      };
      seen.push(...body.items.map((i) => `${i.principalId}/${i.roleId}`));
      cursor = body.next_cursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    const [total] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment where company_id = ${a.company}`;
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(total!.n);
    expect(pages).toBeGreaterThan(1);
  });

  it("expiring the assignment is an update, never a delete (spec:2049)", async () => {
    const response = await api.request({
      method: "DELETE",
      path: `/v1/companies/${a.company}/role-assignments/${invited}/${clerkRole}`,
      as: a.human,
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { expiresAt: string | null }).toMatchObject({
      principalId: invited,
      roleId: clerkRole,
    });
    const [row] = await api.db.admin<{ n: number; expires_at: Date | null }[]>`
      select count(*)::int as n, max(expires_at) as expires_at from app.role_assignment
       where principal_id = ${invited} and role_id = ${clerkRole}`;
    expect(row!.n).toBe(1);
    expect(row!.expires_at).not.toBeNull();
  });

  it("another tenant's company id is 403, and its principal id is 409 ERR_CONFLICT_REFERENCE (never a leak)", async () => {
    const b = await seedTenant(api.db, "Beta");
    expect(
      (
        await api.request({
          method: "POST",
          path: `/v1/companies/${b.company}/role-assignments`,
          as: a.human,
          body: { principalId: invited, roleId: clerkRole },
        })
      ).status,
    ).toBe(403);
    const cross = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/role-assignments`,
      as: a.human,
      body: { principalId: b.human, roleId: clerkRole },
    });
    expect(cross.status).toBe(409);
    expect((await problem(cross)).code).toBe("ERR_CONFLICT_REFERENCE");
    // …and no junk row survives the attempt: the plain FK alone would have accepted it (plan0A:2027).
    const [junk] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_assignment where principal_id = ${b.human}`;
    expect(junk!.n).toBe(0);
  });
});
