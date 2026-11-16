import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { withTenant } from "@dulja/db";
import { seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/accounts — spec:1673, SAH-021, SAH-071", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;
  const grant = async (seed: Seed, code: string): Promise<void> => {
    const roleId = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${seed.tenant}, true), set_config('app.actor_id', ${seed.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${seed.tenant}, ${`r-${code}`}, ${code})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code) values (${seed.tenant}, ${roleId}, ${code})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id) values (${seed.tenant}, ${seed.human}, ${roleId}, ${seed.company})`;
    });
  };

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenantV2(api.db, "Alpha");
    b = await seedTenantV2(api.db, "Beta");
    await grant(a, "accounting.account.manage");
  });
  afterAll(async () => {
    await api.stop();
  });

  it("the accounts 0C seeds and the JOURNAL policy names all resolve (contracts §5 item 33)", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/accounts?limit=1000`,
      as: a.human,
    });
    const body = (await res.json()) as { items: { code: string }[] };
    for (const code of ["1000", "4000", "5920"]) {
      expect(body.items.map((item) => item.code)).toContain(code);
    }
  });

  it("creates a leaf account under a group parent and reads it back", async () => {
    const group = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/accounts`,
      as: a.human,
      body: {
        code: "2000",
        nameEn: "Liabilities",
        nameAr: "الخصوم",
        type: "liability",
        isGroup: true,
      },
    });
    expect(group.status).toBe(201);
    const parent = (await group.json()) as { id: string };
    const leaf = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/accounts`,
      as: a.human,
      body: { code: "2100", nameEn: "Trade payables", type: "liability", parentId: parent.id },
    });
    expect(leaf.status).toBe(201);
    expect(await leaf.json()).toMatchObject({
      code: "2100",
      type: "liability",
      isGroup: false,
      parentId: parent.id,
      archivedAt: null,
    });
  });

  it("refuses a duplicate code in the company with ERR_CONFLICT_UNIQUE", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/accounts`,
      as: a.human,
      body: { code: "1000", nameEn: "Cash again", type: "asset" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Problem).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("archives rather than deletes, and an archived account is excluded from the default list (SAH-021)", async () => {
    const created = (await (
      await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/accounts`,
        as: a.human,
        body: { code: "5990", nameEn: "Retired", type: "expense" },
      })
    ).json()) as { id: string };
    const archived = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/accounts/${created.id}/archive`,
      as: a.human,
      body: {},
    });
    expect(archived.status).toBe(200);
    expect((await archived.json()) as { archivedAt: string | null }).toMatchObject({
      archivedAt: expect.any(String),
    });

    const list = (await (
      await api.request({
        method: "GET",
        path: `/v1/companies/${a.company}/accounts?limit=1000`,
        as: a.human,
      })
    ).json()) as { items: { code: string }[] };
    expect(list.items.map((item) => item.code)).not.toContain("5990");
    const all = (await (
      await api.request({
        method: "GET",
        path: `/v1/companies/${a.company}/accounts?limit=1000&includeArchived=true`,
        as: a.human,
      })
    ).json()) as { items: { code: string }[] };
    expect(all.items.map((item) => item.code)).toContain("5990");
    // `?includeArchived=false` is FALSE. `z.coerce.boolean()` read it as `Boolean("false") === true` and
    // returned the archived rows; `z.stringbool()` reads the word.
    const none = (await (
      await api.request({
        method: "GET",
        path: `/v1/companies/${a.company}/accounts?limit=1000&includeArchived=false`,
        as: a.human,
      })
    ).json()) as { items: { code: string }[] };
    expect(none.items.map((item) => item.code)).not.toContain("5990");
  });

  it("PATCH refuses a parent that belongs to another company of the tenant, exactly as POST does", async () => {
    const otherCompany = await uuidv7(api.db.admin);
    const otherAccount = await uuidv7(api.db.admin);
    await api.db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.company (id, tenant_id, code, name, base_currency) values (${otherCompany}, ${a.tenant}, 'B2', 'Company B2', 'MYR')`;
      await tx`insert into app.account (id, tenant_id, company_id, code, name_en, type, is_group) values (${otherAccount}, ${a.tenant}, ${otherCompany}, '1', 'B assets', 'asset', true)`;
    });
    const res = await api.request({
      method: "PATCH",
      path: `/v1/companies/${a.company}/accounts/${a.cash}`,
      as: a.human,
      body: { parentId: otherAccount },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as Problem).code).toBe("ERR_NOT_FOUND");
    const [row] = await withTenant(
      api.db.rw,
      { tenantId: a.tenant, actorId: a.human, requestId: "read" },
      (tx) => tx<{ parent_id: string | null }[]>`
      select parent_id from app.account where id = ${a.cash}`,
    );
    expect(row!.parent_id).not.toBe(otherAccount);
  });

  it("returns the tree in one recursive CTE with depth and path (SAH-071)", async () => {
    const res = await api.request({
      method: "GET",
      path: `/v1/companies/${a.company}/accounts/tree`,
      as: a.human,
    });
    expect(res.status).toBe(200);
    const tree = (await res.json()) as {
      items: { code: string; depth: number; path: string[] }[];
    };
    const payables = tree.items.find((node) => node.code === "2100")!;
    expect(payables.depth).toBe(1);
    expect(payables.path).toEqual(["2000", "2100"]);
    const root = tree.items.find((node) => node.code === "1000")!;
    expect(root.depth).toBe(0);
  });

  it("refuses a parent from another company and a cycle", async () => {
    const foreign = await api.request({
      method: "POST",
      path: `/v1/companies/${a.company}/accounts`,
      as: a.human,
      body: { code: "2200", nameEn: "Bad parent", type: "liability", parentId: b.cash },
    });
    expect(foreign.status).toBe(404);
    const self = (await (
      await api.request({
        method: "POST",
        path: `/v1/companies/${a.company}/accounts`,
        as: a.human,
        body: { code: "2300", nameEn: "Self", type: "liability", isGroup: true },
      })
    ).json()) as { id: string };
    const cycle = await api.request({
      method: "PATCH",
      path: `/v1/companies/${a.company}/accounts/${self.id}`,
      as: a.human,
      body: { parentId: self.id },
    });
    expect(cycle.status).toBe(400);
    expect(((await cycle.json()) as Problem).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("a principal without accounting.account.manage may read but not write", async () => {
    const read = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}/accounts`,
      as: b.human,
    });
    expect(read.status).toBe(200);
    const write = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/accounts`,
      as: b.human,
      body: { code: "2900", nameEn: "Nope", type: "liability" },
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("cannot reach another tenant's company: the ungated read is an empty page, the gated write is 403 (test 12)", async () => {
    // The two read routes are marked membershipOnly() — contracts §4.2.7: "Reads on `accounts`,
    // `fiscal-periods` and `documents/{id}` are gated by membership only". A `{ company: "path:companyId" }`
    // gate here would answer 403 for an id the caller may not see, and a 403 confirms the id exists —
    // exactly the leak 0B removed from `GET /v1/companies/{companyId}` when it regated that read to
    // `{ company: "any" }`. So on this path the control is RLS, not RBAC: the handler runs inside
    // `withTenant(a.tenant)`, `app.account` is reduced to tenant A's rows, and `where company_id =
    // ${b.company}` matches none of them. The honest answer is an empty page, and asserting 403 here would
    // be asserting the leak.
    const read = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}/accounts`,
      as: a.human,
    });
    expect(read.status).toBe(200);
    expect((await read.json()) as { items: unknown[]; next_cursor: string | null }).toEqual({
      items: [],
      next_cursor: null,
    });

    const tree = await api.request({
      method: "GET",
      path: `/v1/companies/${b.company}/accounts/tree`,
      as: a.human,
    });
    expect(tree.status).toBe(200);
    expect((await tree.json()) as { items: unknown[] }).toEqual({ items: [] });

    // 403 belongs to the gated verbs, and this is the shape the `PROBES` entry for this path exercises.
    const write = await api.request({
      method: "POST",
      path: `/v1/companies/${b.company}/accounts`,
      as: a.human,
      body: { code: "9997", nameEn: "Trespass", type: "asset" },
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as Problem).code).toBe("ERR_RBAC_FORBIDDEN");

    // …and nothing was written under either tenant by the attempt.
    const mine = (await (
      await api.request({
        method: "GET",
        path: `/v1/companies/${a.company}/accounts?limit=1000`,
        as: a.human,
      })
    ).json()) as { items: { code: string }[] };
    expect(mine.items.map((item) => item.code)).not.toContain("9997");
  });
});
