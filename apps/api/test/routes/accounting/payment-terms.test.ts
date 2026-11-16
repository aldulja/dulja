import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@dulja/db";
import { grantCodes, seedTenantV2, uuidv7, type Seed } from "@dulja/db/test";
import { problemOf } from "../../../../../tests/support/api";
import { startApi, type StartedApi } from "../../support/app";

describe("/v1/companies/{companyId}/payment-terms (4A)", () => {
  let api: StartedApi;
  let s: Seed;
  let clerkless: string;
  const base = () => `/v1/companies/${s.company}/payment-terms`;

  /** A member of the tenant with no role at all — what "a principal without accounting.party.manage" is. */
  const memberWithoutGrants = async (label: string): Promise<string> => {
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
    s = await seedTenantV2(api.db, "Payment terms API");
    // `accounting.party.manage` is what these routes gate on (spec:2158 — the clerk who keeps customers and
    // vendors keeps their credit terms); the admin codes are not it, so the grant is made through a real role.
    await grantCodes(api.db, s, { codes: ["accounting.party.manage"], roleCode: "party-clerk" });
    clerkless = await memberWithoutGrants("no-grants");
  }, 180_000);
  afterAll(async () => {
    await api.stop();
  });

  it("POST creates and returns 201 with the wire shape", async () => {
    const res = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      body: { code: "NET14", nameEn: "Net 14 days", dueDays: 14 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      companyId: s.company,
      code: "NET14",
      nameEn: "Net 14 days",
      nameAr: null,
      dueDays: 14,
      discountDays: null,
      discountPct: null,
      archivedAt: null,
    });
    expect(typeof body.createdAt).toBe("string");
  });

  it("POST without an Idempotency-Key is ERR_IDEMPOTENCY_KEY_MISSING (§4.2.9)", async () => {
    const res = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      idempotencyKey: null,
      body: { code: "NOKEY", nameEn: "no key", dueDays: 1 },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_IDEMPOTENCY_KEY_MISSING");
  });

  it("POST replays the same key and hash without creating a second row", async () => {
    const key = "4a-payment-term-replay";
    const body = { code: "NET21", nameEn: "Net 21 days", dueDays: 21 };
    const first = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      idempotencyKey: key,
      body,
    });
    const again = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      idempotencyKey: key,
      body,
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    const list = await api.request({ method: "GET", path: base(), as: s.human });
    const items = ((await list.json()) as { items: { code: string }[] }).items;
    expect(items.filter((i) => i.code === "NET21")).toHaveLength(1);
  });

  it("a duplicate code in the company is 409 ERR_CONFLICT_UNIQUE", async () => {
    const res = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      body: { code: "NET14", nameEn: "again", dueDays: 14 },
    });
    expect(res.status).toBe(409);
    expect((await problemOf(res)).code).toBe("ERR_CONFLICT_UNIQUE");
  });

  it("a discount window wider than the due window is ERR_VALIDATION_FAILED naming the field", async () => {
    const res = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      body: {
        code: "BADWIN",
        nameEn: "bad",
        dueDays: 10,
        discountDays: 20,
        discountPct: "0.010000",
      },
    });
    const problem = await problemOf(res);
    expect(problem.code).toBe("ERR_VALIDATION_FAILED");
    expect(problem.errors?.map((e) => e.path)).toContain("discountDays");
  });

  it("a discountPct that is not a 6-dp fraction is refused on the wire, before the database sees it", async () => {
    const res = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      body: { code: "BADPCT", nameEn: "bad", dueDays: 10, discountDays: 5, discountPct: 0.02 },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("GET pages on code with the shared cursor codec (§4.2.8)", async () => {
    const first = await api.request({ method: "GET", path: `${base()}?limit=1`, as: s.human });
    const page1 = (await first.json()) as { items: { code: string }[]; next_cursor: string | null };
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();
    const second = await api.request({
      method: "GET",
      path: `${base()}?limit=1&cursor=${page1.next_cursor}`,
      as: s.human,
    });
    const page2 = (await second.json()) as { items: { code: string }[] };
    expect(page2.items[0]!.code).not.toBe(page1.items[0]!.code);
  });

  it("PATCH changes dueDays, keeps the code, and refuses a code in the body", async () => {
    const created = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      body: { code: "NET45", nameEn: "Net 45 days", dueDays: 45 },
    });
    const { id } = (await created.json()) as { id: string };
    const res = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: s.human,
      body: { dueDays: 50, nameEn: "Net 50 days" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      code: "NET45",
      dueDays: 50,
      nameEn: "Net 50 days",
    });
    const rename = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: s.human,
      body: { code: "NET50" },
    });
    expect(rename.status).toBe(400);
    expect((await problemOf(rename)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("PATCH that breaks the stored discount window is 400 ERR_VALIDATION_FAILED, never a 500", async () => {
    const created = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      body: {
        code: "2-10-N30",
        nameEn: "2/10 net 30",
        dueDays: 30,
        discountDays: 10,
        discountPct: "0.020000",
      },
    });
    const { id } = (await created.json()) as { id: string };
    const res = await api.request({
      method: "PATCH",
      path: `${base()}/${id}`,
      as: s.human,
      body: { dueDays: 5 },
    });
    expect(res.status).toBe(400);
    expect((await problemOf(res)).code).toBe("ERR_VALIDATION_FAILED");
  });

  it("PATCH and archive of a SIBLING company's term through this company's path are 404 (AGENTS.md)", async () => {
    // RLS bounds the tenant only. The gate clears s.company; a term of another company in the same tenant must
    // not be reachable by its id through s.company's path.
    const sibling = await uuidv7(api.db.admin);
    const foreignTerm = await uuidv7(api.db.admin);
    await withTenant(
      api.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "sibling-setup" },
      async (tx) => {
        await tx`insert into app.company (id, tenant_id, code, name, base_currency)
                 values (${sibling}, ${s.tenant}, 'SIB', 'Sibling', 'MYR')`;
        await tx`insert into app.payment_term (id, tenant_id, company_id, code, name_en, due_days)
                 values (${foreignTerm}, ${s.tenant}, ${sibling}, 'SIB30', 'Sibling net 30', 30)`;
      },
    );
    const patch = await api.request({
      method: "PATCH",
      path: `${base()}/${foreignTerm}`,
      as: s.human,
      body: { dueDays: 1 },
    });
    expect(patch.status).toBe(404);
    expect((await problemOf(patch)).code).toBe("ERR_NOT_FOUND");
    const archive = await api.request({
      method: "POST",
      path: `${base()}/${foreignTerm}/archive`,
      as: s.human,
    });
    expect(archive.status).toBe(404);
    const [row] = await api.db.admin<{ due_days: number; archived_at: Date | null }[]>`
      select due_days, archived_at from app.payment_term where id = ${foreignTerm}`;
    expect(row).toMatchObject({ due_days: 30, archived_at: null });
  });

  it("POST …/archive hides the row from the default list and shows it under filter[archived][eq]=true", async () => {
    const created = await api.request({
      method: "POST",
      path: base(),
      as: s.human,
      body: { code: "GONE", nameEn: "to archive", dueDays: 7 },
    });
    const { id } = (await created.json()) as { id: string };
    const res = await api.request({ method: "POST", path: `${base()}/${id}/archive`, as: s.human });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();
    const dflt = await api.request({ method: "GET", path: `${base()}?limit=100`, as: s.human });
    expect(
      ((await dflt.json()) as { items: { code: string }[] }).items.map((i) => i.code),
    ).not.toContain("GONE");
    const all = await api.request({
      method: "GET",
      path: `${base()}?limit=100&filter[archived][eq]=true`,
      as: s.human,
    });
    expect(
      ((await all.json()) as { items: { code: string }[] }).items.map((i) => i.code),
    ).toContain("GONE");
  });

  it("a principal without accounting.party.manage gets 403 ERR_RBAC_FORBIDDEN", async () => {
    const denied = await api.request({ method: "GET", path: base(), as: clerkless });
    expect(denied.status).toBe(403);
    expect((await problemOf(denied)).code).toBe("ERR_RBAC_FORBIDDEN");
    const write = await api.request({
      method: "POST",
      path: base(),
      as: clerkless,
      body: { code: "SNEAK", nameEn: "sneak", dueDays: 1 },
    });
    expect(write.status).toBe(403);
    // The plan's original probe, kept: the system principal passes app.actor_has by design (plan0A:985).
    const system = await api.request({ method: "GET", path: base(), as: s.system });
    expect([200, 403]).toContain(system.status);
    const stranger = await api.request({ method: "GET", path: base() });
    expect(stranger.status).toBe(401);
  });

  // The PROBES half of hazard 31 is asserted where PROBES lives: `tests/invariants/tenant-isolation.test.ts`'s
  // "has exactly one isolation probe per registered route" compares the key set to ROUTES. This workspace may
  // not import `tests/invariants/probes.ts` (dependency-rule: apps/api/test reaches only tests/support/ and
  // tests/invariants/support/), nor itself as `@dulja/api`, so ROUTES is read by relative path.
  it("the module is in ROUTES, gated accounting.party.manage (hazard 31)", async () => {
    const { ROUTES } = await import("../../../src/routes");
    const mounted = ROUTES.find((r) => r.path === "/v1/companies/:companyId/payment-terms");
    expect(mounted).toBeDefined();
    expect(mounted!.permissions).toEqual(["accounting.party.manage"]);
    expect(mounted!.auth).toBe("human");
  });
});
