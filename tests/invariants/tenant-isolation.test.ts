import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES } from "@dulja/api";
import { JOBS } from "@dulja/db";
import { seedTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../apps/api/test/support/app";
import { PROBES, TENANT_FREE } from "./probes";

describe("acceptance test 12 — endpoint and job tenant isolation", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  const grantEverything = async (seed: Seed): Promise<void> => {
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${seed.tenant}, true), set_config('app.actor_id', ${seed.system}, true)`;
      const [role] = await tx<{ id: string }[]>`
        insert into app.role (tenant_id, code, name_en, is_system)
        values (${seed.tenant}, 'admin', 'Administrator', true) returning id`;
      for (const code of [
        "admin.user.manage",
        "admin.role.manage",
        "admin.role.assign",
        "admin.company.manage",
        "admin.audit_log.read",
      ])
        await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
                 values (${seed.tenant}, ${role!.id}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${seed.tenant}, ${seed.human}, ${role!.id}, ${seed.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grantEverything(a);
    await grantEverything(b);
  });
  afterAll(async () => api.stop());

  it("has exactly one isolation probe per registered route", () => {
    expect(Object.keys(PROBES).toSorted()).toEqual(ROUTES.map((route) => route.path).toSorted());
  });

  for (const route of ROUTES)
    it(`${route.path} refuses tenant A acting on tenant B rows`, async () => {
      const probe = PROBES[route.path]!;
      const request = await probe.seed(api.db, b);
      const [before] = await api.db.admin<{ count: number }[]>`
        select count(*)::int as count from app.audit_log where tenant_id = ${b.tenant}`;
      const response = await api.request({
        method: request.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: request.path,
        as: a.human,
        body: request.body,
      });
      if (TENANT_FREE.has(route.path)) expect([200, 401]).toContain(response.status);
      else if (response.status === 200) {
        const body = (await response.json()) as { items?: { id?: string; rowId?: string }[] };
        const ids = (body.items ?? []).flatMap((item) => [item.id, item.rowId]).filter(Boolean);
        expect(ids).not.toContain(b.company);
        expect(ids).not.toContain(b.human);
      } else expect(response.status, `${request.method} ${request.path}`).toBe(probe.expect);
      const [after] = await api.db.admin<{ count: number }[]>`
        select count(*)::int as count from app.audit_log where tenant_id = ${b.tenant}`;
      expect(after!.count).toBe(before!.count);
    });

  it("covers every app table that 2C added — RLS on, forced, one tenant_isolation policy", async () => {
    for (const table of ["attachment", "print_template"]) {
      const [row] = await api.db.admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relrowsecurity, relforcerowsecurity from pg_class
         where oid = ${`app.${table}`}::regclass`;
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await api.db.admin<{ polname: string }[]>`
        select polname from pg_policy where polrelid = ${`app.${table}`}::regclass`;
      expect(policies.map((p) => p.polname)).toEqual(["tenant_isolation"]);
    }
  });

  it("every route module has a probe — including the two 2C added (hazard 31)", () => {
    const paths = ROUTES.map((r) => r.path);
    expect(paths).toContain("/v1/companies/:companyId/attachments");
    expect(paths).toContain("/v1/companies/:companyId/print-templates");
    for (const p of paths) expect(Object.keys(PROBES)).toContain(p);
  });

  it("enumerates every registered job name", () => {
    expect(Object.keys(JOBS).length).toBeGreaterThan(0);
    for (const name of Object.keys(JOBS)) expect(name).toMatch(/^[a-z_]+(\.[a-z_]+){1,2}$/);
  });
});
