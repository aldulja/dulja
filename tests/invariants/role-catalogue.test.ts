import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@dulja/contracts/permissions";
import { whoCan, withTenant } from "@dulja/db";
import { adminPermissions, INCOMPATIBLE_PAIRS, ROLES } from "@dulja/db/seed/roles";
import { seedBranch, seedTenant, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";

let sharedDb: Db;
const asPrincipal = async <T>(
  sql: Sql,
  tenantId: string,
  actorId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> =>
  withTenant(sql, { tenantId, actorId, requestId: await uuidv7(sharedDb.admin) }, fn);

async function applyRoles(db: Db, seed: Seed): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const role of ROLES) ids.set(role.code, await uuidv7(db.admin));
  await asPrincipal(db.migrator, seed.tenant, seed.system, async (tx) => {
    for (const role of ROLES) {
      await tx`
        insert into app.role (id, tenant_id, code, name_en, name_ar, description, is_system)
        values (${ids.get(role.code)!}, ${seed.tenant}, ${role.code}, ${role.nameEn},
                ${role.nameAr}, ${role.description}, true)`;
      const grants =
        role.code === "admin"
          ? adminPermissions(PERMISSIONS.map((permission) => permission.code))
          : role.permissions;
      for (const code of grants)
        await tx`
          insert into app.role_permission (tenant_id, role_id, permission_code)
          values (${seed.tenant}, ${ids.get(role.code)!}, ${code})`;
    }
  });
  return ids;
}

describe("acceptance tests 14 and 36 against the Phase 0 catalogue", () => {
  let db: Db;
  let a: Seed;
  let b: Seed;
  let roleIds: Map<string, string>;
  let branch: string;
  let clerk: string;

  beforeAll(async () => {
    db = sharedDb = await startDb();
    a = await seedTenant(db, "Alpha");
    b = await seedTenant(db, "Beta");
    roleIds = await applyRoles(db, a);
    await applyRoles(db, b);
    branch = await seedBranch(db, a, { code: "KLANG", nameEn: "Klang branch" });
    clerk = await uuidv7(db.admin);
    await asPrincipal(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${clerk}, 'human', ${`clerk:${a.tenant}`}, 'Alpha clerk')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${clerk})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleIds.get("admin")!}, ${a.company})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${clerk}, ${roleIds.get("auditor")!}, ${a.company})`;
    });
  });
  afterAll(async () => db.stop());

  it("keeps seed grants in the catalogue and computes admin", async () => {
    const rows = await asPrincipal(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx<{ code: string; n: number }[]>`
      select role.code, count(grant_row.permission_code)::int as n
        from app.role role left join app.role_permission grant_row on grant_row.role_id = role.id
       group by role.code order by role.code`,
    );
    const counts = new Map(rows.map((row) => [row.code, row.n]));
    const adminCodes = await asPrincipal(
      db.rw,
      a.tenant,
      a.system,
      (tx) =>
        tx<
          { code: string }[]
        >`select p.permission_code as code from app.role_permission p join app.role r on r.id=p.role_id where r.code='admin' order by p.permission_code`,
    );
    const excluded = PERMISSIONS.map((p) => p.code)
      .filter((code) => !adminCodes.some((grant) => grant.code === code))
      .toSorted();
    expect(excluded).toEqual(["pos.sync.pull", "pos.sync.push", "pos.ticket.sell"]);
    expect(counts.get("admin")).toBe(PERMISSIONS.length - 3);
    // Pinned per role so a grant that fails to land is a count mismatch here. auditor: 0B's audit-log read,
    // 1A's ledger read, 1B's report read and the three Phase 3 reads, 6D POS report read, 7A's report
    // export, 7C's data export and 8B's payroll read — ten, all non-mutating (R7).
    // accountant: 1A's five, 1B's report read, 2B's reverse, 3A's two reads, 3B's cost read, 3C's two
    // purchase codes, 3D's adjustment approval, 4A's six (never accounting.payment.create — R6) and 4B's
    // bank reconcile, Phase 5 tax manage/file, and 8A's statutory-table verify (spec:2163, the second principal
    // of spec:2080 — 8A T2) — 23; plus 8B's payroll read, approve and post (spec:2157, 8B T3) — 26.
    // user: 1A's journal create, 2A's party manage, 3A's two reads, 3C's purchase create, 3D's sales
    // create, 4A's receipt and payment create, and 6C's employee read — 9 (spec:2157–2163, contracts §3.6.4).
    expect(counts.get("auditor")).toBe(10);
    expect(counts.get("accountant")).toBe(26);
    expect(counts.get("user")).toBe(9);
    expect(counts.get("pos_terminal")).toBe(2); // 6A: catalogue pull and ticket push; cashier authority stays separate.
    for (const role of ROLES.filter((candidate) => candidate.code !== "admin"))
      expect(counts.get(role.code), role.code).toBe(role.permissions.length);
  });

  it("keeps the auditor read-only", async () => {
    const rows = await asPrincipal(
      db.rw,
      a.tenant,
      a.system,
      (tx) => tx`
      select permission.code from app.role role
      join app.role_permission grant_row on grant_row.role_id = role.id
      join app.permission permission on permission.code = grant_row.permission_code
      where role.code = 'auditor' and permission.mutating`,
    );
    expect(rows).toEqual([]);
  });

  it("keeps live incompatible pairs off non-admin roles", async () => {
    const catalogue = new Set<string>(PERMISSIONS.map((permission) => permission.code));
    for (const [left, right] of INCOMPATIBLE_PAIRS.filter(
      ([x, y]) => catalogue.has(x) && catalogue.has(y),
    )) {
      const rows = await asPrincipal(
        db.rw,
        a.tenant,
        a.system,
        (tx) => tx`
        select role.code from app.role role where role.code <> 'admin'
        and exists (select 1 from app.role_permission p where p.role_id = role.id and p.permission_code = ${left})
        and exists (select 1 from app.role_permission p where p.role_id = role.id and p.permission_code = ${right})`,
      );
      expect(rows).toEqual([]);
    }
  });

  it("answers who can do X in company Y", async () => {
    expect(
      await asPrincipal(db.rw, a.tenant, a.system, (tx) =>
        whoCan(tx, a.company, "admin.role.assign"),
      ),
    ).toEqual([{ principalId: a.human, displayName: "Alpha owner" }]);
    const auditors = await asPrincipal(db.rw, a.tenant, a.system, (tx) =>
      whoCan(tx, a.company, "admin.audit_log.read"),
    );
    expect(auditors.map((principal) => principal.displayName).toSorted()).toEqual([
      "Alpha clerk",
      "Alpha owner",
    ]);
    // The spec's literal wording, 'accounting.purchase.post', which 3C put in the catalogue (migration 0039):
    // the owner holds it through admin's computed grant, and the clerk's auditor role, read-only, does not.
    // Nothing about the query changed when the code arrived.
    expect(
      await asPrincipal(db.rw, a.tenant, a.system, (tx) =>
        whoCan(tx, a.company, "accounting.purchase.post"),
      ),
    ).toEqual([{ principalId: a.human, displayName: "Alpha owner" }]);
  });

  it("answers with one parameterised principal query", async () => {
    const statements: string[] = [];
    const rw = postgres(db.url("app_rw"), {
      max: 1,
      onnotice: () => {},
      debug: (_connection, query) => statements.push(query),
    });
    try {
      await asPrincipal(rw, a.tenant, a.system, (tx) => whoCan(tx, a.company, "admin.role.assign"));
    } finally {
      await rw.end();
    }
    const query = statements.filter((statement) => /from\s+app\.principal/i.test(statement));
    expect(query).toHaveLength(1);
    expect(query[0]).not.toContain("admin.role.assign");
  });

  it("excludes expired assignments through whoCan and actor_has", async () => {
    await asPrincipal(
      db.migrator,
      a.tenant,
      a.system,
      (tx) => tx`
      update app.role_assignment set expires_at = now() - interval '1 minute'
       where principal_id = ${clerk} and role_id = ${roleIds.get("auditor")!}`,
    );
    expect(
      await asPrincipal(db.rw, a.tenant, a.system, (tx) =>
        whoCan(tx, a.company, "admin.audit_log.read"),
      ),
    ).toEqual([{ principalId: a.human, displayName: "Alpha owner" }]);
    const [answer] = await asPrincipal(
      db.rw,
      a.tenant,
      clerk,
      (tx) => tx<{ ok: boolean }[]>`
      select app.actor_has('admin.audit_log.read', ${a.company}, null) as ok`,
    );
    expect(answer?.ok).toBe(false);
  });

  it("honours branch-restricted assignments", async () => {
    const manager = await uuidv7(db.admin);
    await asPrincipal(db.migrator, a.tenant, a.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${manager}, 'human', ${`manager:${a.tenant}`}, 'Klang manager')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${manager})`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${manager}, ${roleIds.get("branch_manager")!}, ${a.company})`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleIds.get("branch_manager")!}, 'admin.audit_log.read')`;
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${a.tenant}, ${manager}, ${roleIds.get("branch_manager")!}, ${a.company}, ${branch})`;
    });
    const atBranch = await asPrincipal(db.rw, a.tenant, a.system, (tx) =>
      whoCan(tx, a.company, "admin.audit_log.read", branch),
    );
    const atHq = await asPrincipal(db.rw, a.tenant, a.system, (tx) =>
      whoCan(tx, a.company, "admin.audit_log.read", a.hq),
    );
    expect(atBranch.map((principal) => principal.displayName).toSorted()).toEqual([
      "Alpha owner",
      "Klang manager",
    ]);
    expect(atHq.map((principal) => principal.displayName)).toEqual(["Alpha owner"]);
  });

  it("is tenant scoped", async () => {
    expect(
      await asPrincipal(db.rw, b.tenant, b.system, (tx) =>
        whoCan(tx, a.company, "admin.role.assign"),
      ),
    ).toEqual([]);
  });
});
