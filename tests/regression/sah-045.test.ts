import { uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";

thinRegression(
  "SAH-045",
  "Department scoping is a report parameter, not an access control",
  "packages/db/test/tenant-isolation.test.ts",
  async ({ db, rw, a, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-045" };
    const roleId = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.role (id, tenant_id, code, name_en) values (${roleId}, ${a.tenant}, 'sah045', 'SAH-045')`;
      await tx`insert into app.role_permission (tenant_id, role_id, permission_code)
               values (${a.tenant}, ${roleId}, 'admin.audit_log.read')`;
      await tx`insert into app.role_assignment (tenant_id, principal_id, role_id, company_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company})`;
    });

    // Branch scope is data on the assignment (role_assignment_branch), read by the same predicate every route
    // uses — not a parameter a report could pass differently. No branch row means company-wide.
    const [wide] = await withTenant(
      rw,
      ctx,
      (tx) =>
        tx<
          { ok: boolean }[]
        >`select app.actor_has('admin.audit_log.read', ${a.company}, ${a.hq}) as ok`,
    );
    expect(wide!.ok).toBe(true);

    const otherBranch = await uuidv7(db.admin);
    await db.migrator.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenant}, true), set_config('app.actor_id', ${a.system}, true)`;
      await tx`insert into app.dimension_value (id, tenant_id, dimension_type_id, code, name_en)
               values (${otherBranch}, ${a.tenant}, ${a.branchType}, 'SAH045B', 'Other branch')`;
      // The branch row carries the assignment's whole natural key — role_assignment has no surrogate id
      // (plan0A: primary key (principal_id, role_id, company_id, branch_id), composite FK back to it).
      await tx`insert into app.role_assignment_branch (tenant_id, principal_id, role_id, company_id, branch_id)
               values (${a.tenant}, ${a.human}, ${roleId}, ${a.company}, ${a.hq})`;
    });

    const [narrowed] = await withTenant(
      rw,
      ctx,
      (tx) =>
        tx<{ hq: boolean; other: boolean }[]>`
        select app.actor_has('admin.audit_log.read', ${a.company}, ${a.hq})         as hq,
               app.actor_has('admin.audit_log.read', ${a.company}, ${otherBranch})  as other`,
    );
    expect(narrowed).toEqual({ hq: true, other: false }); // scoping is enforced, not merely displayed
  },
);

import { fullRegression } from "../support/api";
import { withTenant } from "@dulja/db";
import { staffFixture, branchActor } from "../invariants/support/staff";
fullRegression("SAH-045", "Department scoping is a report parameter — 6C", {
  "a real branch assignment cannot widen and a company assignment can narrow": async ({
    api,
    expect,
  }) => {
    const f = await staffFixture(api, "SAH045 STAFF");
    const narrow = await branchActor(
      api.db,
      f.seed,
      f.branchA,
      ["hr.employee.read"],
      "sah45-narrow",
    );
    const wide = await branchActor(api.db, f.seed, null, ["hr.employee.read"], "sah45-wide");
    const ctx = (actorId: string) => ({
      tenantId: f.seed.tenant,
      actorId,
      requestId: crypto.randomUUID(),
    });
    const restricted = await withTenant(
      api.db.rw,
      ctx(narrow),
      (tx) => tx`select id from app.employee where home_branch_id=${f.branchB}`,
    );
    expect(restricted).toHaveLength(0);
    const all = await withTenant(api.db.rw, ctx(wide), (tx) => tx`select id from app.employee`);
    const filtered = await withTenant(
      api.db.rw,
      ctx(wide),
      (tx) => tx`select id from app.employee where home_branch_id=${f.branchA}`,
    );
    expect(filtered.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(filtered.length);
  },
});

// ─── 8A ──────────────────────────────────────────────────────────────────────────────────────────────────
// R4 in all four places by direct app_rw SQL — test 31's R4 clause in its filed form (spec:2175). The API twins are
// apps/api/test/routes/hr/{sensitive,compensation}.test.ts.
import { Money as Money045, currency as currency045 } from "@dulja/domain";
import {
  createHrKeyRing as ring045,
  DEV_HR_KEY as KEY_045,
  openCompensation as compensation045,
  openStatutoryProfile as profile045,
  writeSensitive as sensitive045,
} from "@dulja/db";
import {
  grantCodes as grant045,
  seedEmployee as employee045,
  seedPayComponent as component045,
} from "@dulja/db/test";
import { sliceRegression } from "../support/regression";

sliceRegression(
  "SAH-045",
  "Department scoping is a report parameter, not an access control",
  "8A",
  "R4: a principal cannot write their own HR rows by direct app_rw SQL, and another principal may write all four",
  async ({ db, rw, a, expect }) => {
    const ring = ring045({ current: KEY_045, currentVersion: 1 });
    const self = await uuidv7(db.admin);
    await withTenant(
      db.migrator,
      { tenantId: a.tenant, actorId: a.system, requestId: "sah-045-self" },
      async (tx) => {
        await tx`insert into app.principal (id, auth_subject, kind, display_name) values (${self}, ${`sub-${self}`}, 'human', 'Self')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${a.tenant}, ${self})`;
      },
    );
    const codes = ["hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage"];
    await grant045(db, a, { codes, principalId: self, roleCode: "sah045-self" });
    const mine = await employee045(db, a, { employeeNumber: "E-SAH045", principalId: self });
    const componentId = await component045(db, a, { code: "SAH045", kind: "earning" });
    const as = (actorId: string) => ({
      tenantId: a.tenant,
      actorId,
      requestId: crypto.randomUUID(),
    });

    const attempts: [string, (actor: string) => Promise<unknown>][] = [
      [
        "employee.terminated_on",
        (actor) =>
          withTenant(
            rw,
            as(actor),
            (tx) => tx`update app.employee set terminated_on = '2026-12-31' where id = ${mine}`,
          ),
      ],
      [
        "employee_sensitive",
        (actor) =>
          withTenant(rw, as(actor), (tx) =>
            sensitive045(tx, ring, mine, { bank_account: "SYNTHETIC-ACC-SELF" }),
          ),
      ],
      [
        "employee_statutory_profile",
        (actor) =>
          withTenant(rw, as(actor), (tx) =>
            profile045(tx, mine, {
              effectiveFrom: "2026-01-01",
              maritalStatus: "married",
              spouseWorking: false,
              childReliefCount: 9,
              residencyCategory: null,
              extra: {},
            }),
          ),
      ],
      [
        "compensation_line",
        (actor) =>
          withTenant(rw, as(actor), (tx) =>
            compensation045(tx, {
              employeeId: mine,
              componentId,
              effectiveFrom: "2026-01-01",
              amount: Money045.of("99999.0000", currency045("MYR")),
              quantity: null,
            }),
          ),
      ],
    ];
    for (const [label, run] of attempts)
      await expect(run(self), `${label} admitted a self-write`).rejects.toThrow(/ERR_HR_SELF_PAY/);

    // The rule is about SELF, not about the table: another holder writes all four. Its own grant, because a missing
    // one would look exactly like R4 firing on the wrong principal.
    await grant045(db, a, { codes, principalId: a.human, roleCode: "sah045-other" });
    for (const [, run] of attempts) await run(a.human);
    const [row] = await db.admin<{ terminated_on: string }[]>`
      select terminated_on::text as terminated_on from app.employee where id = ${mine}`;
    expect(row!.terminated_on).toBe("2026-12-31");
  },
);
