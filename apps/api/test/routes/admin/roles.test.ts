import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

const problem = async (response: Response): Promise<Problem> => (await response.json()) as Problem;

interface Role {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

describe("/v1/admin/roles — spec:2136, 2152, 2179 R5", () => {
  let api: StartedApi;
  let a: Seed;

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    const roleId = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
               values (${roleId}, ${a.tenant}, 'admin', 'Administrator', true)`;
      for (const code of [
        "admin.user.manage",
        "admin.role.manage",
        "admin.role.assign",
        "admin.company.manage",
        "admin.audit_log.read",
      ])
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${a.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });
  });
  afterAll(async () => api.stop());

  it("creates a role, renames it, replaces its permissions, and lists it", async () => {
    const created = await api.request({
      method: "POST",
      path: "/v1/admin/roles",
      as: a.human,
      body: { code: "clerk", nameEn: "Clerk", nameAr: "كاتب" },
    });
    expect(created.status).toBe(201);
    const role = (await created.json()) as Role;
    expect(role).toMatchObject({
      code: "clerk",
      nameEn: "Clerk",
      permissions: [],
      isSystem: false,
    });

    // PATCH /{roleId}: `coalesce(:new, current)` per column, so an omitted field keeps its value.
    const renamed = await api.request({
      method: "PATCH",
      path: `/v1/admin/roles/${role.id}`,
      as: a.human,
      body: { nameEn: "Senior clerk", description: "Handles the counter" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      id: role.id,
      code: "clerk",
      nameEn: "Senior clerk",
      nameAr: "كاتب",
      description: "Handles the counter",
    });

    const set = await api.request({
      method: "PUT",
      path: `/v1/admin/roles/${role.id}/permissions`,
      as: a.human,
      body: { permissions: ["admin.audit_log.read"] },
    });
    expect(set.status).toBe(200);
    expect((await set.json()) as Role).toMatchObject({
      nameEn: "Senior clerk",
      permissions: ["admin.audit_log.read"],
    });

    // Replacing again removes what is no longer named — the body is the whole grant, not a delta.
    const replaced = await api.request({
      method: "PUT",
      path: `/v1/admin/roles/${role.id}/permissions`,
      as: a.human,
      body: { permissions: ["admin.company.manage"] },
    });
    expect(((await replaced.json()) as Role).permissions).toEqual(["admin.company.manage"]);

    const list = await api.request({
      method: "GET",
      path: "/v1/admin/roles?limit=100",
      as: a.human,
    });
    expect(list.status).toBe(200);
    const codes = ((await list.json()) as { items: Role[] }).items.map((item) => item.code);
    expect(codes.toSorted()).toEqual(["admin", "clerk"]);
  });

  it("renaming a role that is not in this tenant is 404, never a leak", async () => {
    const ghost = await uuidv7(api.db.admin);
    const response = await api.request({
      method: "PATCH",
      path: `/v1/admin/roles/${ghost}`,
      as: a.human,
      body: { nameEn: "Nobody" },
    });
    expect(response.status).toBe(404);
    expect((await problem(response)).code).toBe("ERR_NOT_FOUND");
  });

  it("a code that is not in the catalogue is refused by the FK, as ERR_CONFLICT_REFERENCE", async () => {
    const role = (await (
      await api.request({
        method: "POST",
        path: "/v1/admin/roles",
        as: a.human,
        body: { code: "ghost", nameEn: "Ghost" },
      })
    ).json()) as Role;
    const response = await api.request({
      method: "PUT",
      path: `/v1/admin/roles/${role.id}/permissions`,
      as: a.human,
      body: { permissions: ["admin.invented.code"] },
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("ERR_CONFLICT_REFERENCE");
  });

  it("a seeded system role cannot be edited through the API at all — 409 (spec:2152, ADR 0091)", async () => {
    const [adminRole] = await api.db.admin<{ id: string }[]>`
      select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`;
    const response = await api.request({
      method: "PUT",
      path: `/v1/admin/roles/${adminRole!.id}/permissions`,
      as: a.human,
      body: {
        permissions: [
          "admin.user.manage",
          "admin.role.manage",
          "admin.role.assign",
          "admin.company.manage",
          "admin.audit_log.read",
        ],
      },
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("ERR_RBAC_SYSTEM_ROLE");
  });

  it("a principal cannot widen a custom role they hold — the trigger refuses, not the handler (spec:2179 R5)", async () => {
    const heldRole = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${heldRole}, ${a.tenant}, 'self-held', 'Self held')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${heldRole}, 'admin.audit_log.read')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${heldRole}, ${a.company})`;
    });
    const response = await api.request({
      method: "PUT",
      path: `/v1/admin/roles/${heldRole}/permissions`,
      as: a.human,
      body: { permissions: ["admin.audit_log.read", "admin.company.manage"] },
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("ERR_RBAC_SELF_ESCALATION");
  });

  it("a duplicate role code in the same tenant is ERR_CONFLICT_UNIQUE", async () => {
    const response = await api.request({
      method: "POST",
      path: "/v1/admin/roles",
      as: a.human,
      body: { code: "clerk", nameEn: "Clerk again" },
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("ERR_CONFLICT_UNIQUE");
  });
});
