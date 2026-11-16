import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("GET|POST /v1/companies/{companyId}/warehouses", () => {
  let api: StartedApi;
  let s: Seed;
  let other: Seed;
  let branchManager: string;

  const post = (path: string, body: unknown, as: string = s.human) =>
    api.request({ method: "POST", path, body, as });
  const get = (path: string, as: string = s.human) => api.request({ method: "GET", path, as });
  const create = (body: Record<string, unknown>, as: string = s.human) =>
    post(`/v1/companies/${s.company}/warehouses`, { branchId: s.hq, ...body }, as);

  const secondPrincipal = async (label: string): Promise<string> => {
    const id = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: `${label}-setup` },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${id}, 'human', ${`${label}:${s.tenant}`}, ${label})`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
      },
    );
    return id;
  };

  beforeAll(async () => {
    api = await startApi();
    s = await seedTenantV2(api.db, "Warehouses API");
    other = await seedTenantV2(api.db, "Warehouses API B");
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read", "inventory.item.manage"],
      roleCode: "catalogue",
    });
    branchManager = await secondPrincipal("branch-manager");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("creates a warehouse, defaulting kind to 'stock'", async () => {
    const res = await create({ code: "WH-MAIN", nameEn: "Main store" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      code: "WH-MAIN",
      kind: "stock",
      branchId: s.hq,
      parentId: null,
      archivedAt: null,
    });
  });

  it("requires Idempotency-Key on POST (spec:2055)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/v1/companies/${s.company}/warehouses`,
      as: s.human,
      idempotencyKey: null,
      body: { code: "WH-X", nameEn: "X", branchId: s.hq },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("a duplicate code in one company is a 409", async () => {
    const res = await create({ code: "WH-MAIN", nameEn: "Main again" });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("an unknown kind is a 400 naming the field, never a 500", async () => {
    const res = await create({ code: "WH-BAD", nameEn: "Bad", kind: "virtual" });
    expect(res.status).toBe(400);
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("kind");
  });

  it("lists with a cursor over code, and filters on kind", async () => {
    await create({ code: "WH-AAA", nameEn: "A" });
    await create({ code: "WH-BBB", nameEn: "B" });
    await create({ code: "WH-TRANSIT", nameEn: "In flight", kind: "in_transit" });
    const first = await get(`/v1/companies/${s.company}/warehouses?limit=2`);
    const page1 = (await first.json()) as { items: { code: string }[]; next_cursor: string };
    expect(page1.items.map((w) => w.code)).toEqual(["WH-AAA", "WH-BBB"]);
    expect(page1.next_cursor).toBeTruthy();
    const transit = await get(
      `/v1/companies/${s.company}/warehouses?filter[kind][eq]=in_transit&limit=100`,
    );
    const onlyTransit = (await transit.json()) as { items: { code: string; kind: string }[] };
    expect(onlyTransit.items.map((w) => w.code)).toEqual(["WH-TRANSIT"]);
  });

  it("archive is a POST, and the row leaves the default list", async () => {
    const created = (await (await create({ code: "WH-OLD", nameEn: "Old" })).json()) as {
      id: string;
    };
    const res = await post(`/v1/companies/${s.company}/warehouses/${created.id}/archive`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const list = await get(`/v1/companies/${s.company}/warehouses?limit=1000`);
    const page = (await list.json()) as { items: { code: string }[] };
    expect(page.items.map((w) => w.code)).not.toContain("WH-OLD");
  });

  it("the tree carries depth and the code path, and a cycle is a 409", async () => {
    const root = (await (await create({ code: "WH-ROOT", nameEn: "Root" })).json()) as {
      id: string;
    };
    const child = (await (
      await create({ code: "WH-CHILD", nameEn: "Child", parentId: root.id })
    ).json()) as { id: string };
    const tree = await get(`/v1/companies/${s.company}/warehouses/tree`);
    expect(tree.status).toBe(200);
    const nodes = (await tree.json()) as {
      items: { code: string; depth: number; path: string[] }[];
    };
    const found = nodes.items.find((n) => n.code === "WH-CHILD")!;
    expect(found.depth).toBe(1);
    expect(found.path).toEqual(["WH-ROOT", "WH-CHILD"]);
    // Making the root a child of its own descendant closes a cycle — app.warehouse_no_cycle().
    const cycle = await api.request({
      method: "PATCH",
      path: `/v1/companies/${s.company}/warehouses/${root.id}`,
      as: s.human,
      body: { parentId: child.id },
    });
    expect(cycle.status).toBe(409);
    expect((await problemOf(cycle)).code).toBe("ERR_WAREHOUSE_TREE_CYCLE");
  });

  it("a branch_manager holding only the read codes cannot create a warehouse (spec:2160)", async () => {
    await grantCodes(api.db, s, {
      codes: ["inventory.item.read", "inventory.stock.read"],
      principalId: branchManager,
      roleCode: "branch-manager",
    });
    expect((await get(`/v1/companies/${s.company}/warehouses`, branchManager)).status).toBe(200);
    const write = await create({ code: "WH-NOPE", nameEn: "Nope" }, branchManager);
    expect(write.status).toBe(403);
    expect((await problemOf(write)).code).toBe("ERR_RBAC_FORBIDDEN");
  });

  it("another tenant's company is refused before any row is read (test 12)", async () => {
    expect((await get(`/v1/companies/${other.company}/warehouses`)).status).toBe(403);
  });
});
