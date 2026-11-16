import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

const problem = async (response: Response): Promise<Problem> => (await response.json()) as Problem;

/**
 * ADR 0091 — role administration has a ceiling and system roles are immutable (2026-11-15 review, API-03, API-08,
 * API-09). One tenant, two companies: A (the seed's) and B. The owner administers both; X administers A only;
 * Y works in both.
 */
describe("role administration ceiling — ADR 0091 (API-03, API-08, API-09)", () => {
  let api: StartedApi;
  let t: Seed;
  let companyB: string;
  let x: string;
  let y: string;
  let w: string;
  let userRole: string;
  let ownerRole: string;
  let cashierRole: string;
  let clerkRole: string;

  const OWNER_CODES = [
    "admin.user.manage",
    "admin.role.manage",
    "admin.role.assign",
    "accounting.payment.create",
    "accounting.payment.approve",
  ];

  beforeAll(async () => {
    api = await startApi();
    t = await seedTenant(api.db, "Ceiling");
    const id = () => uuidv7(api.db.admin);
    companyB = await id();
    x = await id();
    y = await id();
    w = await id();
    userRole = await id();
    ownerRole = await id();
    cashierRole = await id();
    clerkRole = await id();
    const xRole = await id();
    await withTenant(api.db.migrator, t.tenant, t.system, async (tx) => {
      await tx`insert into app.company (id, tenant_id, code, name, base_currency)
               values (${companyB}, ${t.tenant}, 'B', 'Company B', 'MYR')`;
      for (const [principal, name] of [
        [x, "X"],
        [y, "Y"],
        [w, "W"],
      ] as const) {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${principal}, 'human', ${`${name}:${t.tenant}`}, ${name})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${t.tenant}, ${principal})`;
      }
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system) values
        (${userRole}, ${t.tenant}, 'user', 'User', true),
        (${cashierRole}, ${t.tenant}, 'cashier', 'Cashier', true),
        (${ownerRole}, ${t.tenant}, 'owner-admin', 'Owner admin', false),
        (${xRole}, ${t.tenant}, 'a-admin', 'Company A admin', false),
        (${clerkRole}, ${t.tenant}, 'clerk', 'Clerk', false)`;
      const grants: [string, string][] = [
        [userRole, "admin.audit_log.read"],
        [cashierRole, "pos.ticket.sell"],
        ...OWNER_CODES.map((code): [string, string] => [ownerRole, code]),
        [xRole, "admin.user.manage"],
        [xRole, "admin.role.manage"],
        [xRole, "admin.role.assign"],
      ];
      for (const [role, code] of grants)
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${t.tenant}, ${role}, ${code})`;
      const assignments: [string, string, string][] = [
        [t.human, ownerRole, t.company],
        [t.human, ownerRole, companyB],
        [x, xRole, t.company],
        [y, userRole, t.company],
        [y, userRole, companyB],
      ];
      for (const [principal, role, company] of assignments)
        await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
                 values (${t.tenant}, ${principal}, ${role}, ${company})`;
    });
  });
  afterAll(async () => api.stop());

  const put = (as: string, roleId: string, permissions: string[]) =>
    api.request({
      method: "PUT",
      path: `/v1/admin/roles/${roleId}/permissions`,
      as,
      body: { permissions },
    });

  describe("API-03 — a system role is immutable through the API (spec:2152)", () => {
    it("refuses granting the seeded `user` role payment and assign codes — 409, the role unchanged", async () => {
      const escalation = [
        "admin.audit_log.read",
        "accounting.payment.create",
        "accounting.payment.approve",
        "admin.role.assign",
      ];
      // X, administering company A only: no authority over a tenant-wide row at all.
      const byX = await put(x, userRole, escalation);
      expect(byX.status).toBe(403);
      expect((await problem(byX)).code).toBe("ERR_RBAC_FORBIDDEN");
      // The owner, administering every company: still refused, because the role is a system role.
      const byOwner = await put(t.human, userRole, escalation);
      expect(byOwner.status).toBe(409);
      expect((await problem(byOwner)).code).toBe("ERR_RBAC_SYSTEM_ROLE");
      const rows = await api.db.admin<{ permission_code: string }[]>`
        select permission_code from app.role_permission where role_id = ${userRole}`;
      expect(rows.map((row) => row.permission_code)).toEqual(["admin.audit_log.read"]);
    });

    it("refuses renaming a system role — 409", async () => {
      const response = await api.request({
        method: "PATCH",
        path: `/v1/admin/roles/${userRole}`,
        as: t.human,
        body: { nameEn: "Everyone" },
      });
      expect(response.status).toBe(409);
      expect((await problem(response)).code).toBe("ERR_RBAC_SYSTEM_ROLE");
    });

    it("editing a custom role needs admin.role.manage at tenant scope, not in any one company — 403", async () => {
      const response = await put(x, clerkRole, ["admin.audit_log.read"]);
      expect(response.status).toBe(403);
      expect((await problem(response)).code).toBe("ERR_RBAC_FORBIDDEN");
      const rename = await api.request({
        method: "PATCH",
        path: `/v1/admin/roles/${clerkRole}`,
        as: x,
        body: { nameEn: "Renamed by X" },
      });
      expect(rename.status).toBe(403);
    });

    it("a code the editor does not hold tenant-wide cannot be added — 403 naming it", async () => {
      const response = await put(t.human, clerkRole, ["accounting.payment.post"]);
      expect(response.status).toBe(403);
      const body = await problem(response);
      expect(body.code).toBe("ERR_RBAC_FORBIDDEN");
      expect(body.detail).toContain("accounting.payment.post");
    });

    it("R6's pairs are evaluated on the resulting set — 409", async () => {
      const response = await put(t.human, clerkRole, [
        "accounting.payment.create",
        "accounting.payment.approve",
      ]);
      expect(response.status).toBe(409);
      expect((await problem(response)).code).toBe("ERR_RBAC_INCOMPATIBLE_PAIR");
    });

    it("an editor holding the code tenant-wide still edits a custom role", async () => {
      const response = await put(t.human, clerkRole, ["accounting.payment.create"]);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { permissions: string[] }).permissions).toEqual([
        "accounting.payment.create",
      ]);
    });
  });

  describe("API-09 — assignment has a ceiling", () => {
    it("refuses assigning a role holding codes the assigner lacks in that company — 403", async () => {
      const response = await api.request({
        method: "POST",
        path: `/v1/companies/${t.company}/role-assignments`,
        as: x,
        body: { principalId: w, roleId: ownerRole },
      });
      expect(response.status).toBe(403);
      const body = await problem(response);
      expect(body.code).toBe("ERR_RBAC_FORBIDDEN");
      expect(body.detail).toContain("accounting.payment.approve");
      const [row] = await api.db.admin<{ n: number }[]>`
        select count(*)::int as n from app.role_assignment where principal_id = ${w}`;
      expect(row!.n).toBe(0);
    });

    it("the till's own codes are exempt, so an administrator still assigns `cashier`", async () => {
      const response = await api.request({
        method: "POST",
        path: `/v1/companies/${t.company}/role-assignments`,
        as: t.human,
        body: { principalId: w, roleId: cashierRole },
      });
      expect(response.status).toBe(201);
    });
  });

  describe("API-08 — expiring a user ends only what the caller administers", () => {
    it("X, administering A only, expires Y's role in A and leaves B's", async () => {
      const response = await api.request({
        method: "POST",
        path: `/v1/admin/users/${y}/expire`,
        as: x,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: y, expiredAssignments: 1 });
      const rows = await api.db.admin<{ company_id: string; live: boolean }[]>`
        select company_id, (expires_at is null or expires_at > now()) as live
          from app.role_assignment where principal_id = ${y} order by company_id = ${companyB}`;
      expect(rows).toEqual([
        { company_id: t.company, live: false },
        { company_id: companyB, live: true },
      ]);
    });
  });
});
