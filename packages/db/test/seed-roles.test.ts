import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES } from "../seed/roles";
import { createDb } from "../src/client";
import { parseSeedArgs } from "../src/seed/config";
import { bootstrapIdentity } from "../src/seed/identity";
import { rolesLoader } from "../src/seed/roles";
import { withTenant } from "../src/with-tenant";
import { startDb, type Db } from "./harness";

describe("the roles loader — §3.6.4, spec:2000 step 4 (OWNER GATE OD-04)", () => {
  let db: Db;
  let migrator: ReturnType<typeof createDb>;
  const tenantId = randomUUID();
  let systemPrincipalId: string;

  beforeAll(async () => {
    db = await startDb();
    migrator = createDb(db.url("app_migrator"));
    const cfg = parseSeedArgs(["--tenant", tenantId], {} as NodeJS.ProcessEnv);
    ({ systemPrincipalId } = await bootstrapIdentity(migrator, cfg, randomUUID()));
    const ctx = { tenantId, actorId: systemPrincipalId, requestId: randomUUID() };
    await withTenant(migrator, ctx, (tx) =>
      rolesLoader.load(tx, {
        config: cfg,
        tenantId,
        companyId: "",
        systemPrincipalId,
        packRoot: cfg.packRoot,
      }),
    );
  });
  afterAll(async () => {
    await migrator.end();
    await db.stop();
  });

  it("seeds the nine system roles, is_system = true, bilingual (test 36 seed clause)", async () => {
    const rows = await db.admin<{ code: string; is_system: boolean; name_ar: string | null }[]>`
      select code, is_system, name_ar from app.role where tenant_id = ${tenantId} order by code`;
    expect(rows.map((r) => r.code)).toEqual(ROLES.map((r) => r.code).toSorted());
    expect(rows.every((r) => r.is_system)).toBe(true);
    expect(rows.every((r) => (r.name_ar ?? "").length > 0)).toBe(true);
  });

  it("`admin` holds every catalogue code except pos.ticket.sell and pos.sync.* (spec:2000, 2156)", async () => {
    const granted = await db.admin<{ permission_code: string }[]>`
      select rp.permission_code from app.role_permission rp join app.role r on r.id = rp.role_id
       where rp.tenant_id = ${tenantId} and r.code = 'admin' order by 1`;
    const catalogue = await db.admin<
      { code: string }[]
    >`select code from app.permission order by code`;
    const expected = catalogue
      .map((c) => c.code)
      .filter((c) => c !== "pos.ticket.sell" && !c.startsWith("pos.sync."));
    expect(granted.map((g) => g.permission_code)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("`auditor` holds only its non-mutating code and no seeded role holds an incompatible pair (R6, R7)", async () => {
    const auditor = await db.admin<{ permission_code: string; mutating: boolean }[]>`
      select rp.permission_code, p.mutating from app.role_permission rp
        join app.role r on r.id = rp.role_id join app.permission p on p.code = rp.permission_code
       where rp.tenant_id = ${tenantId} and r.code = 'auditor'`;
    // Phase 0 seeded the auditor one code; 1B, 3A, 3B and 6D (amendment A8, `pos.report.read`) each gave it
    // a read since (roles-seed.test.ts pins the seed's list). What R7 asks of the loader is unchanged: every
    // code it grants is non-mutating.
    expect(auditor.map((a) => a.permission_code).toSorted()).toEqual([
      "accounting.ledger.read",
      // 7A (migration 0076) — the auditor's export authority, spec:2163.
      "accounting.report.export",
      "accounting.report.read",
      "admin.audit_log.read",
      // 7C (migration 0079) — the tenant data export, spec:2163.
      "admin.data.export",
      // 8B (migration 0089) — the payroll register, posted lines only, spec:2163.
      "hr.payroll.read",
      "inventory.cost.read",
      "inventory.item.read",
      "inventory.stock.read",
      "pos.report.read",
    ]);
    expect(auditor.every((a) => !a.mutating)).toBe(true);
  });

  it("4A's payment pair is live and the loader splits it: user drafts, accountant approves (R6, spec:2177)", async () => {
    // Both halves are in app.permission from migration 0047 on, so the loader grants both (F-21 skips
    // neither) — and to different roles, never one role holding both.
    const holders = await db.admin<{ code: string; permission_code: string }[]>`
      select r.code, rp.permission_code from app.role_permission rp join app.role r on r.id = rp.role_id
       where rp.tenant_id = ${tenantId} and r.code <> 'admin'
         and rp.permission_code in ('accounting.payment.create', 'accounting.payment.approve')
       order by rp.permission_code, r.code`;
    expect(holders).toEqual([
      { code: "accountant", permission_code: "accounting.payment.approve" },
      { code: "user", permission_code: "accounting.payment.create" },
    ]);
  });

  it("a code not yet in app.permission is skipped, not a foreign-key failure (F-21)", async () => {
    const [n] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.role_permission rp
       where rp.tenant_id = ${tenantId} and rp.permission_code not in (select code from app.permission)`;
    expect(n!.n).toBe(0);
  });

  it("re-running grants nothing new and writes no audit row (§3.4.8 idempotence)", async () => {
    const [before] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    const cfg = parseSeedArgs(["--tenant", tenantId], {} as NodeJS.ProcessEnv);
    const ctx = { tenantId, actorId: systemPrincipalId, requestId: randomUUID() };
    const inserted = await withTenant(migrator, ctx, (tx) =>
      rolesLoader.load(tx, {
        config: cfg,
        tenantId,
        companyId: "",
        systemPrincipalId,
        packRoot: cfg.packRoot,
      }),
    );
    expect(inserted).toBe(0);
    const [after] = await db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.audit_log where tenant_id = ${tenantId}`;
    expect(after!.n).toBe(before!.n);
  });

  it("tenant B cannot see tenant A's roles (spec:106 — a second tenant cannot see it)", async () => {
    const other = randomUUID();
    const rows = await withTenant(
      migrator,
      { tenantId: other, actorId: other, requestId: randomUUID() },
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.role`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
