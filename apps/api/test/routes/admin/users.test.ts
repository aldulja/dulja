import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Problem } from "@dulja/contracts";
import { seedTenant, uuidv7, withTenant, type Seed } from "@dulja/db/test";
import { startApi, type StartedApi } from "../../support/app";

const problem = async (response: Response): Promise<Problem> => (await response.json()) as Problem;

describe("/v1/admin/users — spec:2132, 2049; §5.0 row 0.7b 'users invited'", () => {
  let api: StartedApi;
  let a: Seed;
  let b: Seed;

  /** The tenant owner becomes the one administrator, granted by the tenant's own system principal. */
  const grantAdmin = async (seed: Seed): Promise<string> => {
    const roleId = await uuidv7(api.db.admin);
    await withTenant(api.db.migrator, seed.tenant, seed.system, async (tx) => {
      await tx`insert into app.role (id, tenant_id, code, name_en, is_system)
               values (${roleId}, ${seed.tenant}, 'admin', 'Administrator', true)`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${seed.tenant}, ${roleId}, 'admin.user.manage')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${seed.tenant}, ${seed.human}, ${roleId}, ${seed.company})`;
    });
    return roleId;
  };

  const invite = async (email: string, displayName: string): Promise<Response> =>
    api.request({
      method: "POST",
      path: "/v1/admin/users",
      as: a.human,
      body: { email, displayName },
    });

  beforeAll(async () => {
    api = await startApi();
    a = await seedTenant(api.db, "Alpha");
    b = await seedTenant(api.db, "Beta");
    await grantAdmin(a);
    await grantAdmin(b);
  });
  afterAll(async () => api.stop());

  it("invites a user: the subject comes from the server, the principal and membership land together", async () => {
    const response = await invite("clerk@example.test", "Clerk");
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; email: string };
    expect(created.email).toBe("clerk@example.test");

    const [row] = await api.db.admin<{ auth_subject: string; n: number }[]>`
      select p.auth_subject,
             (select count(*)::int from app.membership m where m.principal_id = p.id) as n
        from app.principal p where p.id = ${created.id}`;
    // StubAuthAdmin derives the subject from the address; nothing in the request could have named it.
    expect(row!.auth_subject).toMatch(/^stub:[0-9a-f]{32}$/);
    expect(row!.n).toBe(1);
  });

  it("a client-supplied subject is ignored — the body has no such field (spec:2132)", async () => {
    const response = await api.request({
      method: "POST",
      path: "/v1/admin/users",
      as: a.human,
      body: {
        email: "forger@example.test",
        displayName: "Forger",
        authSubject: "system:evil",
        sub: "system:evil",
      },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const [row] = await api.db.admin<{ auth_subject: string }[]>`
      select auth_subject from app.principal where id = ${created.id}`;
    expect(row!.auth_subject).not.toContain("evil");
    expect(row!.auth_subject).toMatch(/^stub:[0-9a-f]{32}$/);
  });

  it("inviting the same address twice is one principal, and the second never reaches the provider", async () => {
    // The 409 used to come from app.principal.auth_subject's UNIQUE constraint — after the provider had
    // created the user and sent the invitation mail, leaving neither principal nor membership behind and
    // nothing to reconcile the two. With fresh keys and fresh addresses that is unbounded mail to third
    // parties from the project's verified sender, so the address is checked before the provider is asked.
    const first = await invite("twice@example.test", "Twice");
    const sentAfterFirst = api.invitesSent();
    const second = await invite("twice@example.test", "Twice");
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect((await problem(second)).code).toBe("ERR_CONFLICT_UNIQUE");
    expect(api.invitesSent()).toBe(sentAfterFirst);
    const [row] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.principal where email = 'twice@example.test'`;
    expect(row!.n).toBe(1);
  });

  it("the check is case-insensitive, as the provider's own account lookup is", async () => {
    const first = await invite("Mixed.Case@example.test", "Mixed");
    const sentAfterFirst = api.invitesSent();
    const second = await invite("mixed.case@EXAMPLE.test", "Mixed again");
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect((await problem(second)).code).toBe("ERR_CONFLICT_UNIQUE");
    expect(api.invitesSent()).toBe(sentAfterFirst);
  });

  it("another tenant's member is invisible here, so the UNIQUE constraint is still the arbiter", async () => {
    // app.principal's `principal_in_tenant` policy admits only rows this tenant has a membership for, so
    // the pre-check cannot see an address tenant Beta already holds; app.membership.principal_id is
    // UNIQUE, so the row cannot be shared either. The constraint answers, and the provider has already
    // been asked by then — the residual case this fix does not close.
    const held = await api.request({
      method: "POST",
      path: "/v1/admin/users",
      as: b.human,
      body: { email: "crosstenant@example.test", displayName: "Beta's" },
    });
    expect(held.status).toBe(201);
    const sentAfterFirst = api.invitesSent();
    const second = await invite("crosstenant@example.test", "Alpha's");
    expect(second.status).toBe(409);
    expect((await problem(second)).code).toBe("ERR_CONFLICT_UNIQUE");
    expect(api.invitesSent()).toBe(sentAfterFirst + 1);
    const [row] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.principal where email = 'crosstenant@example.test'`;
    expect(row!.n).toBe(1);
  });

  it("lists only this tenant's principals, newest first, with a cursor that never repeats a row", async () => {
    const all = await api.request({
      method: "GET",
      path: "/v1/admin/users?limit=1000",
      as: a.human,
    });
    const ordered = ((await all.json()) as { items: { id: string; createdAt: string }[] }).items;
    const ids = ordered.map((item) => item.id);
    expect(ids).toContain(a.human);
    expect(ids).not.toContain(b.human); // acceptance test 12, through the endpoint
    const stamps = ordered.map((item) => item.createdAt);
    expect(stamps).toEqual(stamps.toSorted().toReversed()); // newest first

    const page = await api.request({ method: "GET", path: "/v1/admin/users?limit=2", as: a.human });
    expect(page.status).toBe(200);
    const body = (await page.json()) as { items: { id: string }[]; next_cursor: string | null };
    expect(body.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(body.next_cursor).not.toBeNull();
    const next = await api.request({
      method: "GET",
      path: `/v1/admin/users?limit=2&cursor=${body.next_cursor}`,
      as: a.human,
    });
    const second = (await next.json()) as { items: { id: string }[] };
    expect(second.items.length).toBeGreaterThan(0);
    const first = body.items.map((item) => item.id);
    expect(second.items.map((item) => item.id).filter((id) => first.includes(id))).toEqual([]);
  });

  it("walking the cursor to exhaustion returns every row exactly once, at any page size", async () => {
    // The regression this pins: the handler encoded the keyset as `last.created_at.toISOString()` —
    // millisecond precision, because postgres.js hands back a JS Date — while app.principal.created_at
    // keeps microseconds. A page boundary falling inside a group of rows that share one created_at
    // dropped the rest of that group, and seedTenant creates exactly such a group (system and human
    // principals are inserted in one transaction, so now() stamps them identically). At limit=2 this
    // tenant returned four of its five rows, silently. The cursor now carries Postgres' own text.
    const all = await api.request({
      method: "GET",
      path: "/v1/admin/users?limit=1000",
      as: a.human,
    });
    const everyId = ((await all.json()) as { items: { id: string }[] }).items.map(
      (item) => item.id,
    );
    expect(everyId.length).toBeGreaterThan(2); // otherwise one page holds them all and proves nothing

    for (const size of [1, 2, 3]) {
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page <= everyId.length + 1; page += 1) {
        const query = `/v1/admin/users?limit=${size}${cursor ? `&cursor=${cursor}` : ""}`;
        const response = await api.request({ method: "GET", path: query, as: a.human });
        expect(response.status, query).toBe(200);
        const body = (await response.json()) as {
          items: { id: string }[];
          next_cursor: string | null;
        };
        walked.push(...body.items.map((item) => item.id));
        cursor = body.next_cursor;
        if (!cursor) break;
      }
      expect(cursor, `limit=${size} never exhausted`).toBeNull();
      expect(walked, `limit=${size}`).toEqual(everyId);
    }
  });

  it("expiring a user expires every unexpired assignment and leaves the principal in place (spec:2049)", async () => {
    const invited = (await (await invite("leaver@example.test", "Leaver")).json()) as {
      id: string;
    };
    const [role] = await api.db.admin<{ id: string }[]>`
      select id from app.role where tenant_id = ${a.tenant} and code = 'admin'`;
    await withTenant(
      api.db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
                 values (${a.tenant}, ${invited.id}, ${role!.id}, ${a.company})`,
    );
    const response = await api.request({
      method: "POST",
      path: `/v1/admin/users/${invited.id}/expire`,
      as: a.human,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: invited.id, expiredAssignments: 1 });

    const [kept] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.principal where id = ${invited.id}`;
    expect(kept!.n).toBe(1);
    // The assignment row survives too — expiry is an update, never a delete.
    const [assignment] = await api.db.admin<{ expires_at: Date | null }[]>`
      select expires_at from app.role_assignment where principal_id = ${invited.id}`;
    expect(assignment!.expires_at).not.toBeNull();
  });

  it("the last administrator cannot be expired — the trigger answers, not the handler (spec:2179 R5)", async () => {
    const response = await api.request({
      method: "POST",
      path: `/v1/admin/users/${a.human}/expire`,
      as: a.human,
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("ERR_RBAC_LAST_ADMIN");
    const [row] = await api.db.admin<{ expires_at: Date | null }[]>`
      select expires_at from app.role_assignment
       where principal_id = ${a.human} and company_id = ${a.company}`;
    expect(row!.expires_at).toBeNull(); // the whole statement rolled back
  });

  // Titled for what it proves. A principal that simply lacks the code is refused in
  // `apps/api/test/middleware/require-permission.test.ts`; this case is about the ONE principal that always
  // holds every code — `actor_has` short-circuits true for `kind = 'system'` in the current tenant — and
  // shows that even that principal is bounded by its tenant.
  it("one tenant's system principal holds every code there and none in another tenant", async () => {
    expect(
      (await api.request({ method: "GET", path: "/v1/admin/users", as: a.system })).status,
    ).toBe(200);
    const outsider = await api.request({
      method: "POST",
      path: "/v1/admin/users",
      as: b.system,
      body: { email: "x@y.test", displayName: "X" },
    });
    expect(outsider.status).toBe(201);
    const [leak] = await api.db.admin<{ n: number }[]>`
      select count(*)::int as n from app.membership
       where tenant_id = ${a.tenant}
         and principal_id in (select id from app.principal where email = 'x@y.test')`;
    expect(leak!.n).toBe(0);
  });
});
