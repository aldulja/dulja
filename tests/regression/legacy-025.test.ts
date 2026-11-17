import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createDb } from "@dulja/db";
import { parseSeedArgs, seed, StubSeedAuthAdmin } from "@dulja/db/seed";
import { fullRegression, problemOf, sharedApi } from "../support/api";
import { repoFile } from "../support/regression";

fullRegression(
  "LEGACY-025",
  "`procQuickLogin` grants a full administrator session with no credentials",
  {
    "no Authorization header reaches nothing — not even the aal1-exempt session route": async ({
      api,
      expect,
    }) => {
      const res = await api.request({ method: "GET", path: "/v1/session" });
      expect(res.status).toBe(401);
      expect((await problemOf(res)).code).toBe("ERR_AUTH_TOKEN_INVALID");
    },

    "there is no credential-free door into any registered route": async ({ api, expect }) => {
      for (const path of [
        "/v1/session",
        "/v1/companies",
        "/v1/admin/users",
        "/v1/admin/roles",
        "/v1/admin/audit-log",
      ]) {
        const res = await api.request({ method: "GET", path });
        expect(res.status).toBe(401);
        expect((await problemOf(res)).code).toBe("ERR_AUTH_TOKEN_INVALID");
      }
    },

    "administrator authority is a role assignment, never a side effect of signing in": async ({
      api,
      a,
      expect,
    }) => {
      const invite = await api.request({
        method: "POST",
        path: "/v1/admin/users",
        as: a.human,
        body: { email: "legacy025@example.test", displayName: "LEGACY-025" },
      });
      expect(invite.status).toBe(201);
      const created = (await invite.json()) as { id: string };
      await api.loadPrincipals();

      // A real, valid, aal2 token for a real member of the tenant — and it can read nothing an admin reads.
      const listed = await api.request({ method: "GET", path: "/v1/admin/users", as: created.id });
      expect(listed.status).toBe(403);
      expect((await problemOf(listed)).code).toBe("ERR_RBAC_FORBIDDEN");
    },
  },
);

// ── appended by slice 0C ──────────────────────────────────────────────────────────────────────────────
// `expect` comes from each test's context: 0B's `fullRegression` callbacks above already bind that name. This block
// uses `sharedApi()`'s database, like 0B's block, because a regression file never mixes it with `sharedDb()`.
describe("LEGACY-025 `procQuickLogin` grants a full administrator session with no credentials — 0C", () => {
  it("the bootstrap administrator is granted BY the system principal, never self-granted (R5)", async ({
    expect,
  }) => {
    const { api } = await sharedApi();
    const migrator = createDb(api.db.url("app_migrator"));
    const tenantId = randomUUID();
    try {
      await seed(
        migrator,
        parseSeedArgs(["--tenant", tenantId, "--owner-email", "legacy025@example.my"], {}),
        new StubSeedAuthAdmin(),
      );
    } finally {
      await migrator.end();
    }
    const rows = await api.db.admin<
      { granted_by_kind: string; granted_by: string; principal_id: string }[]
    >`
      select p.kind::text as granted_by_kind, ra.granted_by::text, ra.principal_id::text
        from app.role_assignment ra
        join app.role r on r.id = ra.role_id
        join app.principal p on p.id = ra.granted_by
       where ra.tenant_id = ${tenantId} and r.code = 'admin'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.granted_by_kind).toBe("system");
    expect(rows[0]!.granted_by).not.toBe(rows[0]!.principal_id);
  });

  it("there is no credential-free path to an admin session: the seed creates no password and no session", ({
    expect,
  }) => {
    const owner = repoFile("packages/db/src/seed/owner.ts");
    expect(owner).not.toMatch(/password|token|session|jwt/i);
    // The application never stores or compares a password — AuthN is Supabase's (spec:2131, LEGACY-028).
    expect(owner).toContain("authAdmin");
  });
});

import { sourceFiles as staffAuthSources } from "../support/source";
describe("LEGACY-025 procQuickLogin grants admin with no credentials — 6C", () => {
  it("PIN endpoints store credentials and never authenticate a session", ({ expect }) => {
    expect(
      staffAuthSources(["apps/api/src"])
        .filter((f) => /\bverifyPin\b/.test(f.text))
        .map((f) => f.path),
    ).toEqual([]);
    const cashierRoute = repoFile("apps/api/src/routes/pos/cashiers.ts");
    expect(cashierRoute).toContain("authAdmin.createUser");
    expect(cashierRoute).toMatch(/created\.sub/);
    expect(cashierRoute).not.toMatch(/body\.(?:sub|authSubject|auth_subject)/);
    expect(cashierRoute).toContain("hashPin");
  });
});

import { seedEmployee, grantCodes } from "@dulja/db/test";
import { posFixture } from "../invariants/support/pos";
fullRegression("LEGACY-025", "procQuickLogin grants admin with no credentials — 6C", {
  "cashier identity uses only the authentication provider subject": async ({ api, expect }) => {
    const f = await posFixture(api, "LEGACY025 STAFF");
    await grantCodes(api.db, f.s, { codes: ["admin.user.manage"] });
    const employeeId = await seedEmployee(api.db, f.s, { employeeNumber: "LEGACY025-NEW" });
    const email = `cashier-${employeeId}@example.invalid`;
    const body = {
      employeeId,
      branchId: f.s.hq,
      displayName: "Regression cashier",
      pin: "7852",
      email,
    };
    const path = `/v1/companies/${f.s.company}/cashiers`;
    const forged = await api.request({
      as: f.s.human,
      method: "POST",
      path,
      body: { ...body, sub: "forged-subject" },
    });
    expect(forged.status).toBe(400);
    const created = await api.request({ as: f.s.human, method: "POST", path, body });
    expect(created.status).toBe(201);
    const response = (await created.json()) as { principalId: string };
    const [principal] = await api.db.admin<
      { auth_subject: string }[]
    >`select auth_subject from app.principal where id=${response.principalId}`;
    expect(principal!.auth_subject).toBe(
      `stub:${createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 32)}`,
    );
    expect(principal!.auth_subject).not.toBe("forged-subject");
  },
});
