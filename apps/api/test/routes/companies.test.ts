import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../support/app";

const problem = async (response: Response): Promise<Problem> => (await response.json()) as Problem;

describe("/v1/companies — spec:2039, 2320 configuration through the API", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  const grant = async (seed: Seed, code: string): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en)
               values (${roleId}, ${seed.tenant}, ${`r-${code}`}, ${code})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${seed.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${seed.tenant}, ${seed.human}, ${roleId}, ${seed.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grant(a, "admin.company.manage");
    await grant(b, "admin.company.manage");
  });
  afterAll(async () => api.stop());

  it("creates a company with MYR and the default timezone, and reads it back", async () => {
    const response = await api.request({
      method: "POST",
      path: "/v1/companies",
      as: a.human,
      body: { code: "BR1", name: "Branch One", baseCurrency: "MYR" },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const one = await api.request({
      method: "GET",
      path: `/v1/companies/${created.id}`,
      as: a.human,
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({
      id: created.id,
      code: "BR1",
      name: "Branch One",
      baseCurrency: "MYR",
      timezone: "Asia/Kuala_Lumpur", // spec:2039 — the first customer's zone is the schema default
    });
  });

  it("lists only this tenant's companies, pages with a cursor, and bounds the page size", async () => {
    const all = await api.request({ method: "GET", path: "/v1/companies?limit=100", as: a.human });
    const ids = ((await all.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toContain(a.company);
    expect(ids).not.toContain(b.company);

    const first = (await (
      await api.request({ method: "GET", path: "/v1/companies?limit=1", as: a.human })
    ).json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).not.toBeNull();
    const second = (await (
      await api.request({
        method: "GET",
        path: `/v1/companies?limit=1&cursor=${first.next_cursor}`,
        as: a.human,
      })
    ).json()) as { items: { id: string }[] };
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(ids.slice(0, 2));

    const tooMany = await api.request({
      method: "GET",
      path: "/v1/companies?limit=1001",
      as: a.human,
    });
    expect(tooMany.status).toBe(400);
    const body = await problem(tooMany);
    expect(body.code).toBe("ERR_VALIDATION_FAILED");
    expect(body.errors?.map((error) => error.path)).toContain("limit");
  });

  it("another tenant's company reads as absent (404) but is refused as a write (403)", async () => {
    // The read is gated `{ company: "any" }` on purpose: `path:companyId` would evaluate actor_has against
    // the foreign company and answer 403, which tells the caller the id exists. The write keeps
    // `path:companyId` — a mutation must name a company the caller actually holds the code in.
    const read = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}`,
      as: a.human,
    });
    expect(read.status).toBe(404);
    expect((await problem(read)).code).toBe("ERR_NOT_FOUND");

    const write = await api.request({
      method: "PATCH",
      path: `/v1/companies/${b.company}`,
      as: a.human,
      body: { name: "Hijacked" },
    });
    expect(write.status).toBe(403);
    expect((await problem(write)).code).toBe("ERR_RBAC_FORBIDDEN");
    const [row] = await api.db.admin<{ name: string }[]>`
      select name from app.company where id = ${b.company}`;
    expect(row!.name).toBe("Beta HQ");
  });

  it("renaming a company writes an audit row with the server-supplied actor (acceptance test 13)", async () => {
    const renamed = await api.request({
      method: "PATCH",
      path: `/v1/companies/${a.company}`,
      as: a.human,
      body: { name: "Alpha HQ renamed" },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: a.company, name: "Alpha HQ renamed" });

    const [row] = await api.db.admin<
      {
        actor_id: string;
        action: string;
        before: { name: string };
        after: { name: string };
      }[]
    >`select actor_id, action, before, after from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'company' and row_id = ${a.company}
       order by seq desc limit 1`;
    expect(row!.actor_id).toBe(a.human); // from the verified token, never from a header or body
    expect(row!.action).toBe("update");
    expect(row!.before.name).toBe("Alpha HQ");
    expect(row!.after.name).toBe("Alpha HQ renamed");
  });
});
