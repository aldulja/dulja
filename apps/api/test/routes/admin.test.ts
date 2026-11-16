import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";
import type { Problem } from "@dulja/contracts";

describe("Phase 0B administrative API", () => {
  let api: StartedApi;
  let seed: Seed;
  let other: Seed;
  /** A member of Alpha holding no role at all — membership admits, nothing else does. */
  let stranger: string;
  beforeAll(async () => {
    api = await startApi();
    seed = await seedTenant(api.db, "Alpha");
    other = await seedTenant(api.db, "Beta");
    stranger = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${stranger}, 'human', ${`human:stranger:${seed.tenant}`}, 'Alpha stranger')`;
      await tx`insert into app.membership (tenant_id, principal_id)
               values (${seed.tenant}, ${stranger})`;
    });
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${seed.tenant}, true), set_config('app.actor_id', ${seed.system}, true)`;
      await tx`insert into app.role(id,tenant_id,code,name_en,is_system) values(${roleId},${seed.tenant},'admin','Administrator',true)`;
      for (const code of [
        "admin.user.manage",
        "admin.role.manage",
        "admin.role.assign",
        "admin.company.manage",
        "admin.audit_log.read",
      ])
        await tx`insert into app.role_permission(tenant_id,role_id,permission_code) values(${seed.tenant},${roleId},${code})`;
      await tx`insert into app.role_assignment(tenant_id,principal_id,role_id,company_id) values(${seed.tenant},${seed.human},${roleId},${seed.company})`;
    });
  });
  afterAll(async () => api.stop());

  it("invites users, manages roles and assignments, companies, and reads audit records", async () => {
    expect(
      (await api.request({ method: "GET", path: "/v1/admin/users", as: seed.human })).status,
    ).toBe(200);
    const invitedResponse = await api.request({
      method: "POST",
      path: "/v1/admin/users",
      as: seed.human,
      body: { email: "clerk@example.test", displayName: "Clerk" },
    });
    expect(invitedResponse.status).toBe(201);
    const invited = (await invitedResponse.json()) as { id: string };
    const roleResponse = await api.request({
      method: "POST",
      path: "/v1/admin/roles",
      as: seed.human,
      body: { code: "clerk", nameEn: "Clerk" },
    });
    expect(roleResponse.status).toBe(201);
    const role = (await roleResponse.json()) as {
      id: string;
      code: string;
      permissions: string[];
      isSystem: boolean;
    };
    expect(role).toMatchObject({
      code: "clerk",
      permissions: [],
      isSystem: false,
    });
    expect(
      (
        await api.request({
          method: "POST",
          path: `/v1/companies/${seed.company}/role-assignments`,
          as: seed.human,
          body: { principalId: invited.id, roleId: role.id },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api.request({
          method: "PATCH",
          path: `/v1/companies/${seed.company}`,
          as: seed.human,
          body: { name: "Alpha HQ" },
        })
      ).status,
    ).toBe(200);
    const audit = await api.request({ method: "GET", path: "/v1/admin/audit-log", as: seed.human });
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as {
      items: { seq: string; actorId: string; tableName: string }[];
    };
    expect(auditBody.items.length).toBeGreaterThan(0);
    expect(typeof auditBody.items[0]!.seq).toBe("string");
    expect(
      auditBody.items.some((item) => item.actorId === seed.human && item.tableName === "company"),
    ).toBe(true);
  });

  it("validates company input and preserves tenant non-disclosure", async () => {
    const invalid = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: seed.human,
      body: { code: "bad code", name: "Bad", baseCurrency: "myr" },
    });
    expect(invalid.status).toBe(400);
    const problem = (await invalid.json()) as Problem;
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((error) => error.path).toSorted()).toEqual(["baseCurrency", "code"]);
    const cross = await api.request({
      method: "GET",
      path: `/v1/companies/${other.company}`,
      as: seed.human,
    });
    expect(cross.status).toBe(404);
  });

  it("refuses every read the Phase 0 review found ungated to a member holding no role", async () => {
    // Each of these was reachable by anyone the tenant admitted: no `requirePermission`, and
    // `assertRouteGates` only judged gates that existed. The gate runs before the zod validators, so
    // the identifiers below need only be well-formed — a 403 here is the gate and nothing else.
    for (const path of [
      "/v1/admin/currencies",
      `/v1/companies/${seed.company}/exchange-rates`,
      `/v1/companies/${seed.company}/exchange-rates/lookup?from=MYR&to=MYR&on=2026-01-15`,
      `/v1/companies/${seed.company}/dimension-types`,
      `/v1/companies/${seed.company}/dimension-types/${seed.branchType}/values`,
      `/v1/companies/${seed.company}/custom-field-definitions?entity=document`,
      `/v1/companies/${seed.company}/custom-fields/document/${seed.docType}`,
    ]) {
      const response = await api.request({ method: "GET", path, as: stranger });
      expect(response.status, path).toBe(403);
      // Not a bare 403: ERR_AUTH_NO_MEMBERSHIP would also be one, and would prove the wrong thing.
      expect(((await response.json()) as Problem).code, path).toBe("ERR_RBAC_FORBIDDEN");
    }
  });

  it("refuses a foreign principal in a local role assignment", async () => {
    const role = (await (
      await api.request({
        method: "POST",
        path: "/v1/admin/roles",
        as: seed.human,
        body: { code: "local_only", nameEn: "Local only" },
      })
    ).json()) as { id: string };
    const response = await api.request({
      method: "POST",
      path: `/v1/companies/${seed.company}/role-assignments`,
      as: seed.human,
      body: { principalId: other.human, roleId: role.id },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as Problem).code).toBe("ERR_CONFLICT_REFERENCE");
  });
});
