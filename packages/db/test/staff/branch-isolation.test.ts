import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDb, uuidv7, withTenant, type Db } from "../harness";
import {
  seedTenant,
  seedTerminal,
  draftDocument,
  seedBranch,
  seedEmployee,
  seedCashier,
  seedBranchPosPolicy,
  seedWarehouse,
  seedItem,
  grantCodes,
  type Seed,
} from "../fixtures";
import { recordAttendance, lintSchema, listApplied, type Violation } from "../../src";

let db: Db;
let s: Seed;
let branchB: string;
let managerA: string; // a branch_manager restricted to s.hq
let managerB: string; // a branch_manager restricted to branchB
let itemId: string; // 3A's item the Form C case puts stock against — `Seed` carries none
let lotId: string; // that item's sentinel 'NONE' lot; stock_on_hand's PK contains lot_id

/** Restrict a fresh principal to one branch through 2B's grantCodes, and return its id. */
async function branchPrincipal(branchId: string, label: string): Promise<string> {
  const id = await uuidv7(db.admin);
  await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
    await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${id}, 'human', ${"sub-" + id}, ${label})`;
    await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${id})`;
  });
  await grantCodes(db, s, {
    codes: ["inventory.stock.read", "hr.employee.read"],
    principalId: id,
    roleCode: `mgr-${label}`,
    branchIds: [branchId],
  });
  return id;
}

/** The `document_parent_visibility_policy` findings of one lint run, as `table:rule`. */
function parentGuardFindings(violations: readonly Violation[]): string[] {
  return violations
    .filter((v) => v.rule === "document_parent_visibility_policy")
    .map((v) => `${v.table}:${v.rule}`);
}

beforeAll(async () => {
  db = await startDb();
  s = await seedTenant(db, "iso");
  // `s.human` is this file's writer for the two helpers 6C may NOT change — 3A's `seedWarehouse` and the
  // Form B `price_list` inserts below — and after this task's own migration both tables carry a
  // `branch_isolation` policy. One company-wide grant (no `branchIds`) is amendment A15's stated remedy for
  // exactly that case: it gives `s.human` a live `app.role_assignment` with no `role_assignment_branch`
  // rows, which `app.actor_in_branch` treats as company-wide authority. Without it this file's `beforeAll`
  // dies at the first `seedWarehouse` with `new row violates row-level security policy for table
  // "warehouse"` and every case below reports as an error rather than a failure.
  await grantCodes(db, s);
  branchB = await seedBranch(db, s, { code: "BR-B" });
  managerA = await branchPrincipal(s.hq, "mgr-a");
  managerB = await branchPrincipal(branchB, "mgr-b");
  // The Form C case needs an item and a lot, and `Seed` carries neither — it is
  // `{ tenant; system; human; company; period; closedPeriod; lockedPeriod; cash; sales; docType; policy;
  //    branchType; hq }` and nothing else (§4.1). 3A creates a sentinel lot coded 'NONE' with every item,
  // which is the lot every non-lot-tracked stock row uses; `stock_on_hand`'s primary key contains
  // `lot_id`, so a NULL there fails.
  const item = await seedItem(db, s, { code: "ISO-A", trackLots: false });
  itemId = item.itemId;
  const [lot] = await withTenant(
    db.rw,
    s.tenant,
    s.human,
    (tx) =>
      tx<{ id: string }[]>`select id from app.lot where item_id = ${itemId} and code = 'NONE'`,
  );
  lotId = lot!.id;
}, 180_000);
afterAll(async () => {
  await db.stop();
});

describe("branch_isolation (§4.5.6; spec:2166; SAH-042, 045)", () => {
  it("migration 68 is applied and every policy is RESTRICTIVE (a permissive gate is OR-ed away)", async () => {
    expect(await listApplied(db.migrator)).toContain(68);
    const rows = await db.admin<{ tablename: string; permissive: string }[]>`
      select tablename, permissive from pg_policies where schemaname = 'app' and policyname = 'branch_isolation' order by 1`;
    expect(rows.every((r) => r.permissive === "RESTRICTIVE")).toBe(true);
    expect(rows.map((r) => r.tablename)).toEqual([
      "attendance_event",
      "branch_pos_policy",
      "catalogue_tombstone",
      "cost_consumption",
      "cost_layer",
      "document",
      "employee",
      "inventory_movement",
      "needs_attention",
      "pos_cashier",
      "pos_terminal",
      "price_list",
      "promotion",
      "public_holiday", // 0096 (8D T8, ⚠️ OD-13 answered build) — Form B, a NULL branch is every branch (8D A8)
      "shift",
      "stock_on_hand",
      "stock_valuation",
      "terminal_enrolment",
      "till_banking_link", // 0071 (OD-10, answered yes 2026-11-04) attaches Form A in its own migration
      "till_event",
      "warehouse",
    ]);
  });

  it("role_assignment_branch carries NO policy — the predicate reads it, and a policy would recurse", async () => {
    const rows = await db.admin<{ policyname: string }[]>`
      select policyname from pg_policies where schemaname = 'app' and tablename = 'role_assignment_branch' and policyname = 'branch_isolation'`;
    expect(rows).toHaveLength(0);
    // and the predicate still answers for a branch-restricted principal — the recursion proof, positively stated
    const [ok] = await withTenant(
      db.rw,
      s.tenant,
      managerA,
      (tx) => tx<{ ok: boolean }[]>`select app.actor_in_branch(${s.company}, ${s.hq}) as ok`,
    );
    expect(ok!.ok).toBe(true);
  });

  it("Form A — a branch_manager at A sees A's cashiers, policies and attendance and not B's", async () => {
    const eA = await seedEmployee(db, s, { employeeNumber: "E-A", homeBranchId: s.hq });
    const eB = await seedEmployee(db, s, { employeeNumber: "E-B", homeBranchId: branchB });
    const cA = await seedCashier(db, s, { employeeId: eA, branchId: s.hq });
    const cB = await seedCashier(db, s, { employeeId: eB, branchId: branchB });
    await seedBranchPosPolicy(db, s, { branchId: s.hq });
    await seedBranchPosPolicy(db, s, { branchId: branchB });

    const seen = await withTenant(
      db.rw,
      s.tenant,
      managerA,
      (tx) =>
        tx<
          { principal_id: string }[]
        >`select principal_id from app.pos_cashier order by principal_id`,
    );
    expect(seen.map((r) => r.principal_id)).toEqual([cA, cB].filter((x) => x === cA));

    const policies = await withTenant(
      db.rw,
      s.tenant,
      managerA,
      (tx) => tx<{ branch_id: string }[]>`select branch_id from app.branch_pos_policy`,
    );
    expect(policies.map((r) => r.branch_id)).toEqual([s.hq]);
  });

  it("Form A′ — employee is keyed on home_branch_id, not branch_id", async () => {
    const rows = await withTenant(
      db.rw,
      s.tenant,
      managerB,
      (tx) =>
        tx<
          { employee_number: string }[]
        >`select employee_number from app.employee order by employee_number`,
    );
    expect(rows.map((r) => r.employee_number)).toEqual(["E-B"]);
  });

  it("Form A″ — an in-transit warehouse is visible to EVERY branch, a stock warehouse only to its own", async () => {
    const whA = await seedWarehouse(db, s, { code: "WH-A", branchId: s.hq });
    const whB = await seedWarehouse(db, s, { code: "WH-B", branchId: branchB });
    const transit = await seedWarehouse(db, s, {
      code: "WH-T",
      kind: "in_transit",
      branchId: s.hq,
    });
    const seen = await withTenant(
      db.rw,
      s.tenant,
      managerB,
      (tx) => tx<{ code: string }[]>`select code from app.warehouse order by code`,
    );
    expect(seen.map((r) => r.code)).toEqual(["WH-B", "WH-T"]);
    expect([whA, whB, transit]).toHaveLength(3);
  });

  it("Form B — a NULL branch means EVERY branch, and Form A would have hidden it", async () => {
    await withTenant(db.rw, s.tenant, s.human, async (tx) => {
      await tx`insert into app.price_list (tenant_id, company_id, code, name_en, currency, branch_id)
               values (${s.tenant}, ${s.company}, 'PL-ALL', 'Company wide', 'MYR', null)`;
      await tx`insert into app.price_list (tenant_id, company_id, code, name_en, currency, branch_id)
               values (${s.tenant}, ${s.company}, 'PL-B', 'Branch B only', 'MYR', ${branchB})`;
    });
    const seen = await withTenant(
      db.rw,
      s.tenant,
      managerA,
      (tx) => tx<{ code: string }[]>`select code from app.price_list order by code`,
    );
    expect(seen.map((r) => r.code)).toEqual(["PL-ALL"]);

    // catalogue_tombstone is the Form B table whose form matters most: a company-wide deletion carries a
    // NULL branch, and under Form A no branch-restricted till or manager would ever learn of it. Archiving
    // both lists writes one tombstone each (6A's catalogue_revision trigger) — PL-ALL's with branch NULL,
    // PL-B's with branch B — and the branch-B one is the control that keeps the NULL case honest.
    await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) =>
        tx`update app.price_list set archived_at = now() where code in ('PL-ALL', 'PL-B') and company_id = ${s.company}`,
    );
    const tombstones = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ row_id: string; code: string; branch_id: string | null }[]>`
        select t.row_id, p.code, t.branch_id from app.catalogue_tombstone t
          join app.price_list p on p.id = t.row_id
         where t.stream = 'price_list' and p.code in ('PL-ALL', 'PL-B') order by p.code`,
    );
    expect(tombstones.map(({ code, branch_id }) => ({ code, branch_id }))).toEqual([
      { code: "PL-ALL", branch_id: null },
      { code: "PL-B", branch_id: branchB },
    ]);
    const [companyWide, branchOnly] = tombstones.map((t) => t.row_id);
    // The readers select the tombstone ALONE: a join to price_list would apply that table's own Form B and
    // hide PL-B whatever the tombstone's policy said, which would make the control vacuous.
    const till = await seedTerminal(db, s, { code: "FORM-B", branchId: s.hq });
    for (const reader of [managerA, till.principalId]) {
      const visible = await withTenant(
        db.rw,
        s.tenant,
        reader,
        (tx) => tx<{ row_id: string }[]>`
          select row_id from app.catalogue_tombstone
           where stream = 'price_list' and row_id = any(${[companyWide!, branchOnly!]}::uuid[])`,
      );
      expect(visible.map((r) => r.row_id)).toEqual([companyWide]);
    }
  });

  it("Form C — stock is isolated through its warehouse, which is the only branch key it has", async () => {
    const whB = await seedWarehouse(db, s, { code: "WH-C", branchId: branchB });
    // EXPLICIT ids, never `select … from app.item join app.lot … limit 1`. `seedTenant` creates no item
    // and no lot, so that select matched nothing, the insert was a no-op, `asB` came back empty and
    // `expect(asA).toHaveLength(0)` passed VACUOUSLY — which is the branch leak this case exists to find.
    // `beforeAll` seeds the item through 3A's own helper and reads its sentinel lot for that reason.
    await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx`
      insert into app.stock_on_hand (tenant_id, company_id, item_id, warehouse_id, lot_id, quantity)
      values (${s.tenant}, ${s.company}, ${itemId}, ${whB}, ${lotId}, 5.000000)`,
    );
    const asB = await withTenant(
      db.rw,
      s.tenant,
      managerB,
      (tx) => tx`select warehouse_id from app.stock_on_hand where warehouse_id = ${whB}`,
    );
    expect(asB).toHaveLength(1); // the row EXISTS — asserted first, so the next line cannot be vacuous
    const asA = await withTenant(
      db.rw,
      s.tenant,
      managerA,
      (tx) => tx`select warehouse_id from app.stock_on_hand where warehouse_id = ${whB}`,
    );
    expect(asA).toHaveLength(0);
  });

  it("the system principal passes every form, so nightly jobs still run (R8, spec:2179)", async () => {
    const rows = await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx<{ n: number }[]>`select count(*)::int as n from app.employee`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it("a company-wide principal (no role_assignment_branch rows) sees every branch", async () => {
    const wide = await uuidv7(db.admin);
    await withTenant(db.migrator, s.tenant, s.system, async (tx) => {
      await tx`insert into app.principal (id, kind, auth_subject, display_name) values (${wide}, 'human', ${"sub-" + wide}, 'wide')`;
      await tx`insert into app.membership (tenant_id, principal_id) values (${s.tenant}, ${wide})`;
    });
    await grantCodes(db, s, {
      codes: ["hr.employee.read"],
      principalId: wide,
      roleCode: "wide-role",
    }); // no branchIds
    const rows = await withTenant(db.rw, s.tenant, wide, (tx) => tx`select id from app.employee`);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("a write into another branch is refused by the policy's WITH CHECK, not only hidden on read", async () => {
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        managerA,
        (tx) => tx`
      insert into app.attendance_event (tenant_id, company_id, employee_id, branch_id, kind, occurred_at)
      select ${s.tenant}, ${s.company}, e.id, ${branchB}, 'clock_in', now()
        from app.employee e where e.employee_number = 'E-A'`,
      ),
    ).rejects.toThrow(/row-level security|42501/);
  });

  it("document lines require a visible parent for SELECT, INSERT, UPDATE and reparenting", async () => {
    const docA = await draftDocument(db, { ...s, human: managerA });
    const docB = await draftDocument(db, { ...s, human: managerB, hq: branchB });
    const [lineA] = await withTenant(
      db.rw,
      s.tenant,
      managerA,
      (tx) =>
        tx<
          { id: string }[]
        >`insert into app.document_line(tenant_id,company_id,document_id,line_no,kind,account_id,debit) values(${s.tenant},${s.company},${docA},1,'account',${s.cash},1) returning id`,
    );
    const [lineB] = await withTenant(
      db.rw,
      s.tenant,
      managerB,
      (tx) =>
        tx<
          { id: string }[]
        >`insert into app.document_line(tenant_id,company_id,document_id,line_no,kind,account_id,debit) values(${s.tenant},${s.company},${docB},1,'account',${s.cash},1) returning id`,
    );
    expect(
      await withTenant(
        db.rw,
        s.tenant,
        managerB,
        (tx) => tx`select id from app.document_line where id=${lineB!.id}`,
      ),
    ).toHaveLength(1);
    expect(
      await withTenant(
        db.rw,
        s.tenant,
        managerA,
        (tx) => tx`select id from app.document_line where id=${lineB!.id}`,
      ),
    ).toHaveLength(0);
    expect(
      await withTenant(
        db.rw,
        s.tenant,
        managerA,
        (tx) =>
          tx`update app.document_line set description='forged' where id=${lineB!.id} returning id`,
      ),
    ).toHaveLength(0);
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        managerA,
        (tx) =>
          tx`insert into app.document_line(tenant_id,company_id,document_id,line_no,kind) values(${s.tenant},${s.company},${docB},2,'text')`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(
        db.rw,
        s.tenant,
        managerA,
        (tx) => tx`update app.document_line set document_id=${docB} where id=${lineA!.id}`,
      ),
    ).rejects.toThrow(/row-level security/);
    const [policy] = await db.admin<
      { permissive: string; qual: string; with_check: string }[]
    >`select permissive,qual,with_check from pg_policies where schemaname='app' and tablename='document_line' and policyname='document_parent_visibility'`;
    expect(policy?.permissive).toBe("RESTRICTIVE");
    expect(policy?.qual).toContain("document_line.company_id");
    expect(policy?.with_check).toContain("document_line.company_id");
  });
  it("linked identity projection preserves a different home branch without widening the employee directory", async () => {
    const employeeId = await seedEmployee(db, s, {
      employeeNumber: "HOME-B-CREDENTIAL-A",
      homeBranchId: branchB,
    });
    const principalId = await seedCashier(db, s, { employeeId, branchId: s.hq });
    const terminal = await seedTerminal(db, s, { code: "RESOLVER-A" });
    expect(
      await withTenant(
        db.rw,
        s.tenant,
        terminal.principalId,
        (tx) => tx`select id from app.employee where id=${employeeId}`,
      ),
    ).toHaveLength(0);
    const projected = await withTenant(
      db.rw,
      s.tenant,
      terminal.principalId,
      (tx) => tx`select * from app.resolve_cashier_employee(${s.company},${s.hq},${principalId})`,
    );
    expect(projected).toEqual([
      { employee_id: employeeId, employee_number: "HOME-B-CREDENTIAL-A" },
    ]);
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      terminal.principalId,
      (tx) =>
        tx<
          { row: { employee_number: string } }[]
        >`select "row" from app.pos_cashier_sync(${s.company},${s.hq},0) where id=${principalId}`,
    );
    expect(row?.row.employee_number).toBe("HOME-B-CREDENTIAL-A");
    const event = await withTenant(db.rw, s.tenant, terminal.principalId, (tx) =>
      recordAttendance(tx, s.company, {
        employeeId,
        kind: "clock_in",
        occurredAt: "2026-01-15T01:00:00Z",
        branchId: s.hq,
        terminalId: terminal.terminalId,
        cashierPrincipalId: principalId,
      }),
    );
    expect(event).toMatchObject({ employeeId, branchId: s.hq, recordedBy: terminal.principalId });
    expect(
      await withTenant(
        db.rw,
        s.tenant,
        managerB,
        (tx) => tx`select * from app.resolve_cashier_employee(${s.company},${s.hq},${principalId})`,
      ),
    ).toHaveLength(0);
    const other = await seedTenant(db, "RESOLVER-FOREIGN");
    expect(
      await withTenant(
        db.rw,
        other.tenant,
        other.system,
        (tx) => tx`select * from app.resolve_cashier_employee(${s.company},${s.hq},${principalId})`,
      ),
    ).toHaveLength(0);
    expect(
      await withTenant(db.rw, s.tenant, terminal.principalId, (tx) =>
        recordAttendance(tx, s.company, {
          employeeId,
          kind: "clock_out",
          occurredAt: "2026-01-15T09:00:00Z",
          branchId: s.hq,
          terminalId: terminal.terminalId,
          cashierPrincipalId: s.human,
        }),
      ),
    ).toBeNull();
    await withTenant(
      db.rw,
      s.tenant,
      s.system,
      (tx) => tx`update app.pos_cashier set revoked_at=now() where principal_id=${principalId}`,
    );
    expect(
      await withTenant(
        db.rw,
        s.tenant,
        terminal.principalId,
        (tx) => tx`select * from app.resolve_cashier_employee(${s.company},${s.hq},${principalId})`,
      ),
    ).toHaveLength(0);
  });
  it("the resolver owns only bounded identity columns and exposes no public EXECUTE", async () => {
    const [fn] = await db.admin<
      { prosecdef: boolean; owner: string; proconfig: string[] }[]
    >`select p.prosecdef,r.rolname as owner,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='app' and p.proname='resolve_cashier_employee'`;
    expect(fn).toMatchObject({
      prosecdef: true,
      owner: "app_auth",
      proconfig: ["search_path=app, pg_temp"],
    });
    const columns = await db.admin<
      { table_name: string; column_name: string }[]
    >`select table_name,column_name from information_schema.column_privileges where grantee='app_auth' and table_schema='app' and table_name in ('employee','pos_cashier','role_assignment','role_assignment_branch') order by table_name,column_name`;
    expect(columns.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "employee.company_id",
      "employee.employee_number",
      "employee.id",
      "employee.tenant_id",
      "pos_cashier.branch_id",
      "pos_cashier.company_id",
      "pos_cashier.employee_id",
      "pos_cashier.principal_id",
      "pos_cashier.revoked_at",
      "pos_cashier.tenant_id",
      "role_assignment.company_id",
      "role_assignment.expires_at",
      "role_assignment.principal_id",
      "role_assignment.role_id",
      "role_assignment.tenant_id",
      "role_assignment_branch.branch_id",
      "role_assignment_branch.company_id",
      "role_assignment_branch.principal_id",
      "role_assignment_branch.role_id",
      "role_assignment_branch.tenant_id",
    ]);
    const [grants] = await db.admin<
      { public_exec: boolean; rw_exec: boolean }[]
    >`select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(p.proacl) acl where n.nspname='app' and p.proname='resolve_cashier_employee' and acl.grantee=0 and acl.privilege_type='EXECUTE') as public_exec,has_function_privilege('app_rw','app.resolve_cashier_employee(uuid,uuid,uuid)','EXECUTE') as rw_exec`;
    expect(grants).toEqual({ public_exec: false, rw_exec: true });
    const roles = await db.admin<
      { tablename: string; roles: string[] }[]
    >`select tablename,roles from pg_policies where schemaname='app' and policyname='branch_isolation' and tablename in ('employee','terminal_enrolment') order by tablename`;
    expect(roles).toEqual([
      { tablename: "employee", roles: ["app_migrator", "app_rw"] },
      { tablename: "terminal_enrolment", roles: ["app_migrator", "app_rw"] },
    ]);
  });
  it("in-transit warehouse lookup still binds the supplied company", async () => {
    const transit = await seedWarehouse(db, s, { code: "TRANSIT-BOUND", kind: "in_transit" });
    const other = await seedTenant(db, "WAREHOUSE-OTHER");
    const [same] = await withTenant(
      db.rw,
      s.tenant,
      managerB,
      (tx) => tx<{ ok: boolean }[]>`select app.actor_in_warehouse(${s.company},${transit}) as ok`,
    );
    expect(same?.ok).toBe(true);
    const [wrong] = await withTenant(
      db.rw,
      s.tenant,
      managerB,
      (tx) =>
        tx<{ ok: boolean }[]>`select app.actor_in_warehouse(${other.company},${transit}) as ok`,
    );
    expect(wrong?.ok).toBe(false);
    const [foreign] = await withTenant(
      db.rw,
      other.tenant,
      other.system,
      (tx) => tx<{ ok: boolean }[]>`select app.actor_in_warehouse(${s.company},${transit}) as ok`,
    );
    expect(foreign?.ok).toBe(false);
  });
  it("the schema linter reports zero violations without altering any security policy", async () => {
    expect(await lintSchema(db.admin)).toEqual([]);
  });

  it("the linter's document_parent_visibility_policy rule fires on a missing or permissive guard (contracts §4.5.6)", async () => {
    // Both mutations run inside ONE transaction that is always rolled back, so the guard the rest of this
    // file relies on is never actually absent. The zero-violation case above is the positive half; this is
    // the proof that the rule is live and would catch a later migration that dropped or weakened the guard.
    const rollback = new Error("rollback");
    const seen: { dropped: string[]; permissive: string[] } = { dropped: [], permissive: [] };
    await expect(
      db.admin.begin(async (tx) => {
        await tx`drop policy document_parent_visibility on app.document_line`;
        seen.dropped = parentGuardFindings(await lintSchema(tx as unknown as typeof db.admin));
        await tx`create policy document_parent_visibility on app.document_line as permissive
                 using (exists (select 1 from app.document d where d.id = document_line.document_id))`;
        seen.permissive = parentGuardFindings(await lintSchema(tx as unknown as typeof db.admin));
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(seen).toEqual({
      dropped: ["document_line:document_parent_visibility_policy"],
      permissive: ["document_line:document_parent_visibility_policy"],
    });
    const [restored] = await db.admin<{ permissive: string }[]>`
      select permissive from pg_policies
       where schemaname = 'app' and tablename = 'document_line' and policyname = 'document_parent_visibility'`;
    expect(restored?.permissive).toBe("RESTRICTIVE");
  });
});
