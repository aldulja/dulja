import { uuidv7 } from "@dulja/db/test";
import { thinRegression } from "../support/regression";

thinRegression(
  "SAH-044",
  "Session records are caller-controlled and attributable to the wrong user",
  "packages/db/test/audit.test.ts",
  async ({ db, rw, a, b, withTenant, expect }) => {
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-044" };
    const id = await uuidv7(db.admin);
    // The plan aimed this at app.company (plan0B:6871), which carries no actor column and never had a
    // stamp trigger, so the assertion passed on a parse error. app.document is where stamp_actor is
    // actually attached (plan0A migration 0001 §8), so that is where the invariant has to be proven.
    // The statement supplies ANOTHER TENANT'S principal as created_by; the BEFORE INSERT trigger
    // overwrites it from the session, so a DEFAULT is not the only control and a caller cannot
    // mis-attribute a write (plan0A:2365).
    await withTenant(
      rw,
      ctx,
      (tx) => tx`
        insert into app.document
          (id, tenant_id, company_id, document_type_id, posting_policy_id, series, fiscal_period_id,
           effective_date, currency, branch_id, created_by)
        values (${id}, ${a.tenant}, ${a.company}, ${a.docType}, ${a.policy}, 'JV', ${a.period},
                '2026-01-15', 'MYR', ${a.hq}, ${b.human})`,
    );
    const [row] = await db.admin<{ created_by: string }[]>`
      select created_by from app.document where id = ${id}`;
    expect(row!.created_by).toBe(a.human);
    expect(row!.created_by).not.toBe(b.human);

    // And once stamped it is frozen: re-attributing a write is a check_violation, not an update.
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`update app.document set created_by = ${b.human} where id = ${id}`,
      ),
    ).rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);
  },
);

import { fullRegression as posActorRegression } from "../support/api";
import { buildTicket, posFixture, syncRequest, uuidv7Sync } from "../invariants/support/pos";
posActorRegression("SAH-044", "POS actor remains the terminal session — 6A", {
  "foreign cashier fails and accepted attribution cannot replace the actor": async ({
    api,
    b,
    expect,
  }) => {
    const f = await posFixture(api, "SAH044 POS");
    const good = buildTicket(f);
    const bad = buildTicket(f, { cashierPrincipalId: b.human });
    const res = await syncRequest(api, f.terminal, {
      method: "POST",
      path: "/v1/sync/tickets",
      body: {
        terminalId: f.terminal.terminalId,
        batchId: uuidv7Sync(),
        tickets: [bad, good],
        shifts: [],
        tillEvents: [],
      },
    });
    const out = (await res.json()) as { results: { status: string }[] };
    expect(out.results.map((r) => r.status)).toEqual(["rejected", "accepted"]);
    const [doc] = await api.db.admin<
      { created_by: string; posted_by: string; attributed_to: string }[]
    >`select created_by,posted_by,attributed_to from app.document where client_ref=${good.clientRef}`;
    expect(doc).toEqual({
      created_by: f.terminal.principalId,
      posted_by: f.terminal.principalId,
      attributed_to: f.cashierId,
    });
    expect(doc!.created_by).not.toBe(doc!.attributed_to);
  },
});

import { staffFixture, applyTicket } from "../invariants/support/staff";
posActorRegression(
  "SAH-044",
  "Session records are caller-controlled and attributable to the wrong user — 6C",
  {
    "one approved discount preserves both actor and attributed humans": async ({ api, expect }) => {
      const f = await staffFixture(api, "SAH044 STAFF");
      const outcome = await applyTicket(f, {
        cashierPrincipalId: f.cashierA,
        lines: [{ quantity: "1", unitPrice: "100.0000", discount: "25.0000" }],
        events: [
          {
            kind: "override",
            code: "pos.ticket.override",
            subject: "discount",
            supervisorPrincipalId: f.supervisorA,
            reason: "regression proof",
          },
        ],
      });
      expect(outcome.status).toBe("accepted");
      const [document] = await api.db.admin<
        { created_by: string; posted_by: string; attributed_to: string }[]
      >`select created_by,posted_by,attributed_to from app.document where id=${outcome.documentId}`;
      expect(document).toEqual({
        created_by: f.terminalA.principalId,
        posted_by: f.terminalA.principalId,
        attributed_to: f.cashierA,
      });
      const events = await api.db.admin<
        { actor_id: string; attributed_to: string }[]
      >`select actor_id,attributed_to from app.document_event where document_id=${outcome.documentId} and event_kind='override'`;
      expect([...events]).toEqual([
        { actor_id: f.terminalA.principalId, attributed_to: f.supervisorA },
      ]);
    },
  },
);

// ─── 8A ──────────────────────────────────────────────────────────────────────────────────────────────────
// Every *_by column 8A adds is stamped from the session, whatever the caller sends.
import {
  grantCodes as grant044,
  seedEmployee as employee044,
  seedPayComponent as component044,
  seedRateTable as table044,
  seedStatutoryScheme as scheme044,
} from "@dulja/db/test";
import { sliceRegression } from "../support/regression";

sliceRegression(
  "SAH-044",
  "Session records are caller-controlled and attributable to the wrong user",
  "8A",
  "every *_by column 8A adds is stamped from the session, a write-once stamp is immutable, and the verifier is the session's",
  async ({ db, rw, a, b, withTenant, expect }) => {
    await grant044(db, a, {
      codes: ["hr.employee.read_sensitive", "hr.compensation.read", "hr.compensation.manage"],
      principalId: a.human,
      roleCode: "sah044-writer",
    });
    // The impostor is ANOTHER tenant's principal, as 0B's own block uses — the stamp must overwrite it regardless.
    const impostor = b.human;
    const employeeId = await employee044(db, a, { employeeNumber: "E-SAH044" });
    const componentId = await component044(db, a, { code: "SAH044", kind: "earning" });
    const schemeId = await scheme044(db, a, { code: "SAH044" });
    const ctx = { tenantId: a.tenant, actorId: a.human, requestId: "sah-044-8a" };
    await withTenant(rw, ctx, async (tx) => {
      await tx`insert into app.employee_sensitive (employee_id, tenant_id, key_version, updated_by)
               values (${employeeId}, ${a.tenant}, 1, ${impostor})`;
      await tx`insert into app.employee_statutory_profile (tenant_id, employee_id, effective_from, entered_by)
               values (${a.tenant}, ${employeeId}, '2026-01-01', ${impostor})`;
      await tx`insert into app.compensation_line (tenant_id, employee_id, component_id, effective_from, amount, entered_by)
               values (${a.tenant}, ${employeeId}, ${componentId}, '2026-01-01', 1000.0000, ${impostor})`;
      await tx`insert into app.statutory_rate_table (tenant_id, scheme_id, version, effective_from, definition, source, loaded_by)
               values (${a.tenant}, ${schemeId}, 1, '2026-01-01', '{}'::jsonb, 'synthetic', ${impostor})`;
    });
    const [s] = await db.admin<
      { v: string }[]
    >`select updated_by as v from app.employee_sensitive where employee_id = ${employeeId}`;
    const [p] = await db.admin<
      { v: string }[]
    >`select entered_by as v from app.employee_statutory_profile where employee_id = ${employeeId}`;
    const [c] = await db.admin<
      { v: string; id: string }[]
    >`select entered_by as v, id from app.compensation_line where employee_id = ${employeeId}`;
    const [t] = await db.admin<
      { v: string }[]
    >`select loaded_by as v from app.statutory_rate_table where scheme_id = ${schemeId}`;
    for (const got of [s!.v, p!.v, c!.v, t!.v]) {
      expect(got).toBe(a.human);
      expect(got).not.toBe(impostor);
    }

    // A write-once stamp cannot be changed afterwards. `employee_sensitive.updated_by` is deliberately not here: it
    // is the one ALWAYS stamp (A19), proven by packages/db/test/hr/sensitive.test.ts's "names the LAST writer" case.
    await expect(
      withTenant(
        rw,
        ctx,
        (tx) => tx`update app.compensation_line set entered_by = ${a.system} where id = ${c!.id}`,
      ),
    ).rejects.toThrow(/ERR_ACTOR_IMMUTABLE/);

    // The rate-table VERIFIER is read from the session: claiming another principal signed stores the session's.
    const synth = await scheme044(db, a, { code: "SAH044B" });
    const tableId = await table044(db, a, { schemeId: synth });
    await withTenant(
      rw,
      { tenantId: a.tenant, actorId: a.system, requestId: "sah-044-verify" },
      (tx) =>
        tx`update app.statutory_rate_table set verified_at = now(), verified_by = ${a.human} where id = ${tableId}`,
    );
    const [row] = await db.admin<
      { verified_by: string }[]
    >`select verified_by from app.statutory_rate_table where id = ${tableId}`;
    expect(row!.verified_by).toBe(a.system);
  },
);

// ─── 8C ──────────────────────────────────────────────────────────────────────────────────────────────────
// The termination trigger (0093, spec:2090) writes as the TERMINATING actor and takes no actor of its own.
import { beforeAll, describe, expect as expect8c, it } from "vitest";
import {
  grantCodes as grant044c,
  seedCashier as cashier044c,
  seedEmployee as employee044c,
  seedTenantV2 as tenant044c,
  type Db as Db044c,
  type Seed as Seed044c,
} from "@dulja/db/test";
import { withTenant as withTenant044c } from "@dulja/db";
import { sharedDb as sharedDb044c } from "../support/regression";

describe("SAH-044 Session records are caller-controlled and attributable to the wrong user — 8C", () => {
  let db: Db044c;
  let s: Seed044c;
  let employeeId: string;
  let principalId: string;

  beforeAll(async () => {
    db = (await sharedDb044c()).db;
    s = await tenant044c(db, "SAH-044 8C"); // its own tenant: the block terminates a member of it
    // The TERMINATING actor needs a role assignment, or the UPDATE below matches zero rows and the block passes
    // vacuously (Global Constraint 21(b), the silent shape).
    await grant044c(db, s, { codes: ["hr.employee.manage", "hr.employee.read"] });
    principalId = await uuidv7(db.admin);
    await withTenant044c(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "sah-044-8c-seed" },
      async (tx) => {
        await tx`insert into app.principal (id, kind, auth_subject, display_name)
                 values (${principalId}, 'human', ${`test:sah044:${principalId}`}, 'SAH-044 staff')`;
        await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
      },
    );
    employeeId = await employee044c(db, s, { employeeNumber: "S44-1", principalId });
    await cashier044c(db, s, {
      employeeId,
      branchId: s.hq,
      principalId,
      pin: "123456",
      permissions: ["pos.ticket.sell"],
    });
    await grant044c(db, s, { codes: ["hr.employee.read"], principalId, roleCode: "r-s44" });
    const [done] = await withTenant044c(
      db.rw,
      { tenantId: s.tenant, actorId: s.human, requestId: "sah-044-8c" },
      (tx) =>
        tx<{ id: string }[]>`
          update app.employee set terminated_on = '2026-01-20' where id = ${employeeId} returning id`,
    );
    expect8c(done).toBeDefined(); // the row was visible, so the trigger fired
  }, 180_000);

  it("every audited row the termination wrote names the TERMINATING principal, never the terminated one", async () => {
    // `pos_cashier` is AUDIT_EXEMPT (§3.5.3) and contributes no row; its revocation is asserted in
    // packages/db/test/hr/termination.test.ts. The employee row and every expired assignment are audited.
    const rows = await db.admin<{ table_name: string; actor_id: string; action: string }[]>`
      select table_name, actor_id, action from app.audit_log
       where tenant_id = ${s.tenant}
         and ((table_name = 'employee' and row_id = ${employeeId} and action = 'update')
           or (table_name = 'role_assignment' and after->>'principal_id' = ${principalId}
               and after->>'expires_at' is not null))
       order by seq`;
    expect8c(rows.map((r) => r.table_name)).toEqual(
      expect8c.arrayContaining(["employee", "role_assignment"]),
    );
    expect8c(rows.filter((r) => r.table_name === "role_assignment")).toHaveLength(2);
    for (const row of rows) {
      expect8c(row.actor_id).toBe(s.human);
      expect8c(row.actor_id).not.toBe(principalId);
      expect8c(row.action).toBe("update"); // expired, never deleted (spec:2049)
    }
  });

  it("app.terminate_employee takes NO actor argument and is SECURITY INVOKER — a caller cannot supply one", async () => {
    const [fn] = await db.admin<{ nargs: number; security_definer: boolean }[]>`
      select pronargs::int as nargs, prosecdef as security_definer
        from pg_proc where oid = 'app.terminate_employee'::regproc`;
    expect8c(fn).toEqual({ nargs: 0, security_definer: false });
  });
});
