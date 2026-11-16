import { join } from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { formatPosture, REPO_ROOT, verifySupabase } from "@dulja/db/provision/verify-supabase";

const base = process.env["STAGING_BASE_URL"];
const rwUrl = process.env["DATABASE_URL"];
const adminUrl = process.env["DATABASE_URL_MIGRATOR"];
const gate = base && rwUrl && adminUrl ? describe : describe.skip;

/**
 * `STAGING_TENANT_ID` is required by two cases below and is deliberately **not** part of the gate above.
 * Adding it there would turn an unset variable into a skipped suite and a green run that asserted nothing
 * about staging — the same "empty is not absence" trap `.github/workflows/release.yml` guards against, in
 * the one suite whose whole job is to be the Phase 0 exit evidence. So it is asserted instead, by name:
 * unset, it used to reach Postgres as `''` and come back "invalid input syntax for type uuid", which names
 * neither the variable nor the fix.
 */
function requireTenantId(): string {
  const value = process.env["STAGING_TENANT_ID"];
  if (!value)
    throw new Error(
      "STAGING_TENANT_ID is required — the tenant id minted once by the first `bun run seed` (docs/runbooks/deploy.md)",
    );
  return value;
}

/** One short-lived connection per case; `onnotice` silenced so a deployed database's notices never fail a run. */
async function withConnection<T>(url: string, fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

/**
 * The Phase 0 exit gate (contracts §2.1): "every §5.0 row green **and** tests 11, 12, 13, 14, 27 pass in CI".
 * Tests 11, 12, 13, 14 and 27 run against Testcontainers on every PR (0B, 0D). This suite re-runs the parts that can
 * only be true of a *deployed* system: the posture of the real database, the edge/container split, and the fact
 * that the seeded tenant is reachable through the Worker and isolated at the data layer.
 *
 * It runs raw statements outside `withTenant` deliberately — it tests the deployed database, not the application —
 * and uses `set_config(…, false)` (session scope) on its own single connection for the same reason.
 */
gate("Phase 0 exit gate — against staging", () => {
  it("row 0.2: the deployed database's posture is the four expected lines", async () => {
    const checks = await verifySupabase({
      rwUrl: rwUrl!,
      adminUrl: adminUrl!,
      configFiles: [join(REPO_ROOT, "infra/wrangler.jsonc")],
    });
    expect(formatPosture(checks)).toBe(
      "rls-forced: ok\nbypassrls-probe: refused\napp_auth-login: refused\npooler-url: absent",
    );
  });

  it("row 0.5: /healthz answers 200 through the Worker", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("row 0.5: an unauthenticated /v1 call is refused at the edge, with RateLimit headers present", async () => {
    const res = await fetch(`${base}/v1/companies`);
    expect(res.status).toBe(401);
    expect(res.headers.get("RateLimit-Limit")).toBe("600");
    expect(((await res.json()) as { code: string }).code).toBe("ERR_AUTH_TOKEN_INVALID");
  });

  it("test 12 at the deployed data layer: app_rw with no set_config sees nothing", async () => {
    await withConnection(rwUrl!, async (sql) => {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from app.company`;
      expect(row!.n).toBe(0);
    });
  });

  it("test 13 at the deployed data layer: app_rw cannot UPDATE or DELETE an audit row", async () => {
    await withConnection(rwUrl!, async (sql) => {
      await expect(sql`update app.audit_log set action = 'x'`).rejects.toThrow(
        /permission denied|violates/,
      );
      await expect(sql`delete from app.audit_log`).rejects.toThrow(/permission denied|violates/);
    });
  });

  it("test 14 against the seeded staging tenant: 'who can manage users in company X' is one query", async () => {
    // Contracts §6.1 places test 14 with 0D — "the 0A query against the seeded catalogue". This is that one
    // statement, principal ⋈ role_assignment ⋈ role_permission filtered on expires_at, run against the tenant
    // `bun run seed` created on staging.
    const tenantId = requireTenantId();
    await withConnection(adminUrl!, async (sql) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, false)`;
      const [company] = await sql<{ id: string }[]>`
        select id::text as id from app.company where tenant_id = ${tenantId}`;
      const who = await sql<{ id: string; display_name: string }[]>`
        select distinct p.id::text as id, p.display_name
          from app.principal p
          join app.role_assignment ra on ra.principal_id = p.id
          join app.role_permission rp on rp.role_id = ra.role_id
         where ra.company_id = ${company!.id} and rp.permission_code = 'admin.user.manage'
           and (ra.expires_at is null or ra.expires_at > now())
         order by p.display_name`;
      // Exactly the bootstrap owner: the seed grants `admin` to one human principal and to no one else.
      expect(who).toHaveLength(1);
      const [owner] = await sql<{ id: string }[]>`
        select p.id::text as id from app.principal p
          join app.membership m on m.principal_id = p.id
         where m.tenant_id = ${tenantId} and p.kind = 'human'`;
      expect(who[0]!.id).toBe(owner!.id);
      // …and the answer is one query, not a walk: the same statement with a different code returns none.
      const nobody = await sql<{ id: string }[]>`
        select distinct p.id::text as id from app.principal p
          join app.role_assignment ra on ra.principal_id = p.id
          join app.role_permission rp on rp.role_id = ra.role_id
         where ra.company_id = ${company!.id} and rp.permission_code = 'pos.ticket.sell'
           and (ra.expires_at is null or ra.expires_at > now())`;
      expect(nobody).toEqual([]); // `admin` excludes pos.ticket.sell (§4.2.1)
    });
  });

  it("row 0.7b: the seeded tenant is fully configured on staging", async () => {
    const tenantId = requireTenantId();
    await withConnection(adminUrl!, async (sql) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, false)`;
      const [c] = await sql<{ n: number }[]>`
        select count(*)::int as n from app.company where fx_rounding_account_id is not null`;
      const [p] = await sql<{ n: number }[]>`
        select count(*)::int as n from app.fiscal_period where status = 'open'`;
      const [r] = await sql<
        { n: number }[]
      >`select count(*)::int as n from app.role where is_system`;
      expect([c!.n, p!.n, r!.n]).toEqual([1, 12, 9]);
    });
  });
});
