import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client";
import { StubSeedAuthAdmin } from "../src/seed/auth-admin";
import { parseSeedArgs } from "../src/seed/config";
import { bootstrapIdentity } from "../src/seed/identity";
import { bootstrapCompany, bootstrapOwner } from "../src/seed/owner";
import { rolesLoader } from "../src/seed/roles";
import { withTenant } from "../src/with-tenant";
import { startDb, type Db } from "./harness";

describe("seed step 4 — owner, company, admin assignment (spec:2000; OWNER GATE OD-21)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  const cfg = () =>
    parseSeedArgs(
      [
        "--tenant",
        tenantId,
        "--owner-email",
        "owner@example.my",
        "--company-name",
        "Example Sdn Bhd",
      ],
      {} as NodeJS.ProcessEnv,
    );
  let systemPrincipalId = "";
  let companyId = "";
  const auth = new StubSeedAuthAdmin();

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
    ({ systemPrincipalId } = await bootstrapIdentity(migrator, cfg(), randomUUID()));
    ({ companyId } = await bootstrapCompany(migrator, cfg(), systemPrincipalId, randomUUID()));
    await withTenant(
      migrator,
      { tenantId, actorId: systemPrincipalId, requestId: randomUUID() },
      (tx) =>
        rolesLoader.load(tx, {
          config: cfg(),
          tenantId,
          companyId,
          systemPrincipalId,
          packRoot: cfg().packRoot,
        }),
    );
    await bootstrapOwner(migrator, cfg(), { systemPrincipalId, companyId }, auth, randomUUID());
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  it("the company carries the owner's legal name, MYR and the first customer's timezone (spec:2039)", async () => {
    const [c] = await db.admin<
      { code: string; name: string; base_currency: string; timezone: string }[]
    >`select code, name, base_currency, timezone from app.company where id = ${companyId}`;
    expect(c).toEqual({
      code: "HQ",
      name: "Example Sdn Bhd",
      base_currency: "MYR",
      timezone: "Asia/Kuala_Lumpur",
    });
  });

  it("the owner's principal carries the Supabase-obtained sub, never a client-supplied subject (spec:2132)", async () => {
    const [p] = await db.admin<{ kind: string; auth_subject: string; email: string }[]>`
      select kind::text, auth_subject, email from app.principal where email = 'owner@example.my'`;
    expect(p!.kind).toBe("human");
    expect(p!.auth_subject).toBe((await auth.findByEmail("owner@example.my"))!.sub);
    expect(p!.auth_subject).not.toMatch(/^(system|terminal):/); // the 0001 CHECK; a prefix cannot impersonate a kind
  });

  it("the admin assignment is granted BY the system principal, so R5 no-self-grant holds (spec:2000)", async () => {
    const [a] = await db.admin<
      { granted_by: string; principal_id: string; expires_at: string | null }[]
    >`
      select ra.granted_by::text, ra.principal_id::text, ra.expires_at::text
        from app.role_assignment ra join app.role r on r.id = ra.role_id
       where ra.tenant_id = ${tenantId} and r.code = 'admin'`;
    expect(a!.granted_by).toBe(systemPrincipalId);
    expect(a!.granted_by).not.toBe(a!.principal_id);
    expect(a!.expires_at).toBeNull();
  });

  it("the owner can answer test 14's question through app.actor_has", async () => {
    const [p] = await db.admin<
      { id: string }[]
    >`select id::text as id from app.principal where email = 'owner@example.my'`;
    const rows = await withTenant(
      migrator,
      { tenantId, actorId: p!.id, requestId: randomUUID() },
      (tx) =>
        tx<{ ok: boolean }[]>`select app.actor_has('admin.user.manage', ${companyId}, null) as ok`,
    );
    expect(rows[0]!.ok).toBe(true);
  });

  it("a second run finds the existing auth user and inserts nothing — one owner, not two (spec:2317)", async () => {
    // `app.principal` has no tenant_id column — the membership row carries the tenant — so this count is
    // repository-wide, on the container superuser, because principal_in_tenant would otherwise hide rows.
    const [before] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.principal`;
    const created = auth.createdCount;
    await bootstrapCompany(migrator, cfg(), systemPrincipalId, randomUUID());
    await bootstrapOwner(migrator, cfg(), { systemPrincipalId, companyId }, auth, randomUUID());
    expect(auth.createdCount).toBe(created);
    const [after] = await db.admin<{ n: number }[]>`select count(*)::int as n from app.principal`;
    expect(after!.n).toBe(before!.n);
  });
});
