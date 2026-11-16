import { sliceRegression, thinRegression } from "../support/regression";
import { seedTenantV2 } from "@dulja/db/test";

thinRegression(
  "SAH-021",
  "Accounts can be deleted with posted entries; the ID generator then rewinds and reuses their IDs",
  "packages/db/test/privileges.test.ts",
  async ({ db, expect }) => {
    const [priv] = await db.admin<{ del: boolean }[]>`
      select has_table_privilege('app_rw', 'app.account', 'delete') as del`;
    expect(priv!.del).toBe(false); // §3.5.4: the DELETE list does not include account

    const [archived] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'archived_at'`;
    expect(archived!.n).toBe(1); // spec:2049: master data is archived, never deleted

    const [id] = await db.admin<{ column_default: string | null }[]>`
      select column_default from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'id'`;
    expect(id!.column_default).toMatch(/uuidv7\(\)/); // no max()+1 generator to rewind, no id to re-issue

    // `audit_log.seq` comes from a non-cycling sequence that never goes backwards, and no BUSINESS identifier is
    // an identity — so deleting a row can never free an id for reuse. Since 0125 (DBS-02, ADR 0094) that
    // sequence is drawn by `app.audit_chain()` under the tenant lock rather than by an identity column, so the
    // check names the column's owned sequence instead of `is_identity`. A targeted absence for `id`, because
    // later slices add tables.
    const [seq] = await db.admin<{ seq: string | null; cycles: boolean | null }[]>`
      select pg_get_serial_sequence('app.audit_log', 'seq') as seq,
             (select seqcycle from pg_sequence
               where seqrelid = pg_get_serial_sequence('app.audit_log', 'seq')::regclass) as cycles`;
    expect(seq!.seq).toBe("app.audit_log_chain_seq");
    expect(seq!.cycles).toBe(false);
    const identities = await db.admin<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
       where table_schema = 'app' and is_identity = 'YES' order by table_name, column_name`;
    expect(identities.filter((i) => i.column_name === "id")).toEqual([]);
  },
);

sliceRegression(
  "SAH-021",
  "Accounts deletable with postings; generator rewinds and reuses IDs",
  "1A",
  "app_rw holds no DELETE on account, and archiving is the only removal",
  async ({ db, expect }) => {
    const grants = await db.admin<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app' and table_name = 'account'`;
    expect(grants.map((grant) => grant.privilege_type).toSorted()).toEqual([
      "INSERT",
      "SELECT",
      "UPDATE",
    ]);
    const cols = await db.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'account' and column_name = 'archived_at'`;
    expect(cols).toHaveLength(1);
  },
);

sliceRegression(
  "SAH-021",
  "Accounts deletable with postings; generator rewinds and reuses IDs",
  "1A",
  "a posting_seq is never rewound: it is drawn once and the unique per company holds",
  async ({ db, rw, withTenant, expect }) => {
    const seed = await seedTenantV2(db, "SAH021-1A");
    const ctx = { tenantId: seed.tenant, actorId: seed.human, requestId: "sah021" };
    const [first, second] = await withTenant(rw, ctx, async (tx) => {
      const [x] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      const [y] = await tx<{ n: string }[]>`select nextval('app.posting_seq')::text as n`;
      return [BigInt(x!.n), BigInt(y!.n)];
    });
    expect(second!).toBeGreaterThan(first!);
  },
);

// ─── 8C ──────────────────────────────────────────────────────────────────────────────────────────────────
// The defect's shape is a DANGLING REFERENCE THAT OUTLIVES ITS PARENT; the Phase 8 instance is a till credential
// outliving its employee. Termination (0093) stamps rather than deletes, and 0094's deferred constraint refuses a live
// credential for a terminated employee from either side (spec:2090).
import {
  beforeAll as beforeAll021c,
  describe as describe021c,
  expect as expect021c,
  it as it021c,
} from "vitest";
import {
  grantCodes as grant021c,
  seedCashier as cashier021c,
  uuidv7 as uuidv7021c,
  type Db as Db021c,
  type Seed as Seed021c,
} from "@dulja/db/test";
import { withTenant as withTenant021c } from "@dulja/db";
import { sharedDb as sharedDb021c } from "../support/regression";
import {
  moneyOutFixture as moneyOut021c,
  type MoneyOutFixture,
} from "../invariants/support/payroll-money";

describe021c("SAH-021 A reference that outlives its parent — 8C", () => {
  let db: Db021c;
  let s: Seed021c;
  let f: MoneyOutFixture;
  let employeeId: string;
  let principalId: string;
  let cashiersBefore: number;
  let assignmentsBefore: number;
  let payrollLinesBefore: number;
  const ctx = (actorId: string) => ({ tenantId: s.tenant, actorId, requestId: "sah-021-8c" });

  const counts = async () => {
    const [cashiers] = await db.admin<{ n: number; revoked: number }[]>`
      select count(*)::int as n, count(revoked_at)::int as revoked
        from app.pos_cashier where tenant_id = ${s.tenant}`;
    const [assignments] = await db.admin<{ n: number; expired: number }[]>`
      select count(*)::int as n, count(expires_at)::int as expired
        from app.role_assignment where tenant_id = ${s.tenant}`;
    const [lines] = await db.admin<{ n: number }[]>`
      select count(*)::int as n from app.payroll_line where employee_id = ${employeeId}`;
    return { cashiers: cashiers!, assignments: assignments!, lines: lines!.n };
  };

  beforeAll021c(async () => {
    db = (await sharedDb021c()).db;
    s = await seedTenantV2(db, "SAH-021 8C"); // its own tenant: the block terminates a member of it
    f = await moneyOut021c(db, s); // a posted run, so the employee has payroll_line rows
    employeeId = f.employeeAId;

    // 8B's fixture gives its employees no login (its own cases need none); this block does. The principal is added
    // here — payrollFixture is 8B's and is not edited (hazard 9).
    principalId = await uuidv7021c(db.admin);
    await withTenant021c(db.migrator, ctx(s.system), async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${principalId}, 'human', ${`test:sah021:${principalId}`}, 'SAH-021 staff')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${principalId})`;
      await tx`update app.employee set principal_id = ${principalId} where id = ${employeeId}`;
    });
    await cashier021c(db, s, { employeeId, branchId: s.hq, principalId, pin: "123456" });
    await grant021c(db, s, { codes: ["hr.employee.read"], principalId, roleCode: "r-s21" });

    const before = await counts();
    cashiersBefore = before.cashiers.n;
    assignmentsBefore = before.assignments.n;
    payrollLinesBefore = before.lines;
    expect021c(payrollLinesBefore).toBeGreaterThan(0);

    const done = await withTenant021c(
      db.rw,
      ctx(s.human),
      (tx) =>
        tx<{ id: string }[]>`
          update app.employee set terminated_on = '2026-01-20' where id = ${employeeId} returning id`,
    );
    expect021c(done).toHaveLength(1); // the row was visible, so the trigger fired (Global Constraint 21(b))
  }, 240_000);

  it021c("a NEW cashier cannot be created against a terminated employee", async () => {
    const other = await uuidv7021c(db.admin);
    await withTenant021c(db.migrator, ctx(s.system), async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name)
               values (${other}, 'human', ${`test:sah021:${other}`}, 'SAH-021 second credential')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${other})`;
    });
    await expect021c(
      cashier021c(db, s, { employeeId, branchId: s.hq, principalId: other, pin: "654321" }),
    ).rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
  });

  it021c(
    "an existing credential cannot be UN-revoked while the employee is terminated",
    async () => {
      await expect021c(
        withTenant021c(
          db.rw,
          ctx(s.human),
          (tx) =>
            tx`update app.pos_cashier set revoked_at = null where principal_id = ${principalId}`,
        ),
      ).rejects.toThrow(/ERR_HR_CASHIER_NOT_EMPLOYEE/);
    },
  );

  it021c("termination DELETED nothing — the rows are still there, only stamped", async () => {
    // The legacy defect deleted the parent and left the children dangling; the fix keeps both and marks the state.
    const after = await counts();
    expect021c(after.cashiers.n).toBe(cashiersBefore);
    expect021c(after.cashiers.revoked).toBeGreaterThan(0);
    expect021c(after.assignments.n).toBe(assignmentsBefore);
    expect021c(after.assignments.expired).toBeGreaterThan(0);
  });

  it021c("the terminated employee keeps every payroll line (spec:2049's retention)", async () => {
    expect021c((await counts()).lines).toBe(payrollLinesBefore);
  });

  it021c(
    "app_rw holds no DELETE on either table, so the defect is unreachable by privilege too (§3.5.4)",
    async () => {
      const grants = await db.admin<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'app_rw' and table_schema = 'app'
         and table_name in ('pos_cashier', 'employee', 'payroll_line')`;
      expect021c(grants.length).toBeGreaterThan(0); // the three tables are granted at all, so the filter is real
      expect021c(grants.filter((g) => g.privilege_type === "DELETE")).toEqual([]);
    },
  );
});
