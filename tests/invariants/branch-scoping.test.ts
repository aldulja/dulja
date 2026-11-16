import { applyBatch } from "@dulja/db";
import { seedShift, grantCodes } from "@dulja/db/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { withTenant, rebuildStockValuation } from "@dulja/db";
import { seedWarehouse, seedTerminal, seedDocumentType, type Db } from "@dulja/db/test";
import { sharedApi } from "../support/api";
import { staffFixture, branchActor, type StaffFixture } from "./support/staff";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
} from "./support/post-inventory";
let db: Db,
  f: StaffFixture,
  managerA: string,
  managerB: string,
  warehouseB: string,
  issueMovement: string;
const TABLES = [
  ["document", "branch_id"],
  ["pos_terminal", "branch_id"],
  ["pos_cashier", "branch_id"],
  ["branch_pos_policy", "branch_id"],
  ["attendance_event", "branch_id"],
  ["terminal_enrolment", "branch_id"],
  ["needs_attention", "branch_id"],
  ["employee", "home_branch_id"],
  ["shift", "branch_id"],
  ["till_event", "branch_id"],
  // ⚠️ OD-10 (answered yes, 2026-11-04): 0071 attaches Form A to the banking link in its own migration.
  ["till_banking_link", "branch_id"],
  ["warehouse", "branch_id"],
  ["inventory_movement", "warehouse_id"],
  ["stock_on_hand", "warehouse_id"],
  ["cost_layer", "warehouse_id"],
  ["cost_consumption", "movement_id"],
  ["stock_valuation", "warehouse_id"],
] as const;
const ctx = (actorId: string) => ({
  tenantId: f.seed.tenant,
  actorId,
  requestId: crypto.randomUUID(),
});
beforeAll(async () => {
  const { api } = await sharedApi();
  db = api.db;
  f = await staffFixture(api, "SCOPE36");
  managerA = await branchActor(
    db,
    f.seed,
    f.branchA,
    [
      "hr.employee.read",
      "inventory.stock.read",
      "accounting.ledger.read",
      "pos.cashier.manage_pin",
    ],
    "scope-manager-a",
  );
  managerB = await branchActor(
    db,
    f.seed,
    f.branchB,
    [
      "hr.employee.read",
      "inventory.stock.read",
      "accounting.ledger.read",
      "pos.cashier.manage_pin",
    ],
    "scope-manager-b",
  );
  warehouseB = await seedWarehouse(db, f.seed, { code: "SCOPE-WH-B", branchId: f.branchB });
  const terminalB = await seedTerminal(db, f.seed, { code: "SCOPE-TB", branchId: f.branchB });
  await grantCodes(db, f.seed, {
    codes: ["pos.shift.own"],
    principalId: f.cashierB,
    branchIds: [f.branchB],
    roleCode: "scope-till-b",
  });
  const shiftB = await seedShift(db, f.seed, {
    branchId: f.branchB,
    terminalId: terminalB.terminalId,
    cashierPrincipalId: f.cashierB,
  });
  await withTenant(db.rw, ctx(terminalB.principalId), async (tx) => {
    const result = await applyBatch(
      tx,
      ctx(terminalB.principalId),
      { ...terminalB, companyId: f.seed.company, branchId: f.branchB },
      {
        terminalId: terminalB.terminalId,
        batchId: crypto.randomUUID(),
        tickets: [],
        shifts: [],
        tillEvents: [
          {
            clientRef: crypto.randomUUID(),
            shiftId: shiftB,
            kind: "no_sale",
            ticketClientRef: null,
            cashierPrincipalId: f.cashierB,
            supervisorPrincipalId: null,
            occurredAt: new Date().toISOString(),
          },
        ],
        cashEvents: [
          {
            clientRef: crypto.randomUUID(),
            shiftId: shiftB,
            kind: "banking",
            amount: { amount: "1.0000", currency: "MYR" },
            cashierPrincipalId: f.cashierB,
            supervisorPrincipalId: null,
            occurredAt: new Date().toISOString(),
            reference: null,
            fromSafe: false,
          },
        ],
      },
    );
    expect(result.tillEventResults[0]!.status).toBe("accepted");
    expect(result.cashEventResults[0]!.status).toBe("accepted");
  });

  const [receiptType] = await db.admin<
    { id: string }[]
  >`select id from app.document_type where company_id=${f.seed.company} and code='STOCK_RECEIPT_TEST'`;
  const issueType = await seedDocumentType(db, f.seed, {
    code: "STOCK_ISSUE_TEST",
    module: "inventory",
    policy: STOCK_ISSUE_COST_POLICY,
  });
  for (const [documentTypeId, quantity, date] of [
    [receiptType!.id, "5.000000", "2026-10-09"],
    [issueType, "1.000000", "2026-10-09"],
  ] as const)
    await postInventoryDocument(db, f.seed, {
      actorId: f.seed.system,
      documentTypeId,
      branchId: f.branchB,
      warehouseId: warehouseB,
      effectiveDate: date,
      jobs: recordingJobs(),
      lines: [
        {
          itemId: f.itemId,
          unitId: f.unitId,
          warehouseId: warehouseB,
          quantity,
          unitPrice: "1.0000",
        },
      ],
    });
  await withTenant(db.rw, ctx(f.seed.system), async (tx) => {
    await rebuildStockValuation(tx, { companyId: f.seed.company, asOf: "2026-10-09" });
    const [movement] = await tx<
      { id: string }[]
    >`select id from app.inventory_movement where warehouse_id=${warehouseB} and quantity<0`;
    issueMovement = movement!.id;
    const [employee] = await tx<
      { id: string }[]
    >`select id from app.employee where home_branch_id=${f.branchB} limit 1`;
    await tx`insert into app.attendance_event(tenant_id,company_id,employee_id,branch_id,kind,occurred_at) values(${f.seed.tenant},${f.seed.company},${employee!.id},${f.branchB},'clock_in',now())`;
    await tx`insert into app.terminal_enrolment(tenant_id,company_id,branch_id,code_hash,name,terminal_code,expires_at) values(${f.seed.tenant},${f.seed.company},${f.branchB},${createHash("sha256").update("SCOPE-SECRET-B").digest()},'Scope B','SCOPE-PENDING-B',now()+interval '1 day')`;
    await tx`insert into app.needs_attention(tenant_id,company_id,branch_id,terminal_id,client_ref,payload,error_code,error_detail) values(${f.seed.tenant},${f.seed.company},${f.branchB},${terminalB.terminalId},${crypto.randomUUID()},'{}'::jsonb,'ERR_POS_LIMIT_EXCEEDED','scope proof')`;
  });
}, 300_000);
describe("acceptance36 identified branch rows", () => {
  it.each(TABLES)("manager A cannot read B %s rows while manager B can", async (table, column) => {
    const value =
      column === "warehouse_id" ? warehouseB : column === "movement_id" ? issueMovement : f.branchB;
    const count = async (actorId: string) => {
      const [row] = await withTenant(db.rw, ctx(actorId), (tx) =>
        tx.unsafe<{ n: number }[]>(`select count(*)::int n from app.${table} where ${column}=$1`, [
          value,
        ]),
      );
      return row!.n;
    };
    expect(await count(managerB)).toBeGreaterThan(0);
    expect(await count(managerA)).toBe(0);
  });
  it("covers all twenty-one branch policies and the independent document-line parent guard", async () => {
    const policies = await db.admin<
      { tablename: string; permissive: string }[]
    >`select tablename,permissive from pg_policies where schemaname='app' and policyname='branch_isolation'`;
    // 21 since 0096 (8D T8, ⚠️ OD-13 answered build) attached Form B to public_holiday (8D A8).
    expect(policies).toHaveLength(21);
    expect(policies.every((p) => p.permissive === "RESTRICTIVE")).toBe(true);
    expect(
      policies
        .map((p) => p.tablename)
        .filter((t) => !TABLES.some(([table]) => table === t))
        .toSorted(),
    ).toEqual(["catalogue_tombstone", "price_list", "promotion", "public_holiday"]);
    const rows =
      await db.admin`select 1 from pg_policies where schemaname='app' and tablename='document_line' and policyname='document_parent_visibility' and permissive='RESTRICTIVE'`;
    expect(rows).toHaveLength(1);
  });
  it("WITH CHECK refuses writing attendance into B and a filter cannot widen an A assignment", async () => {
    const [employee] = await withTenant(
      db.rw,
      ctx(managerA),
      (tx) =>
        tx<{ id: string }[]>`select id from app.employee where home_branch_id=${f.branchA} limit 1`,
    );
    await expect(
      withTenant(
        db.rw,
        ctx(managerA),
        (tx) =>
          tx`insert into app.attendance_event(tenant_id,company_id,employee_id,branch_id,kind,occurred_at) values(${f.seed.tenant},${f.seed.company},${employee!.id},${f.branchB},'clock_in',now())`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      await withTenant(
        db.rw,
        ctx(managerA),
        (tx) => tx`select id from app.employee where home_branch_id=${f.branchB}`,
      ),
    ).toHaveLength(0);
  });
  it("company-wide scope can narrow to a branch but branch scope never widens", async () => {
    const wide = await branchActor(db, f.seed, null, ["hr.employee.read"], "scope-wide");
    const all = await withTenant(db.rw, ctx(wide), (tx) => tx`select id from app.employee`),
      narrow = await withTenant(
        db.rw,
        ctx(wide),
        (tx) => tx`select id from app.employee where home_branch_id=${f.branchA}`,
      );
    expect(all.length).toBeGreaterThan(narrow.length);
  });
  it("one query identifies the B PIN manager and expiry removes that authority", async () => {
    const read = () =>
      withTenant(
        db.rw,
        ctx(f.seed.system),
        (tx) =>
          tx<
            { principal_id: string }[]
          >`select principal_id from app.who_can_reset_a_pin where company_id=${f.seed.company} and (branch_id is null or branch_id=${f.branchB})`,
      );
    const ids = (await read()).map((r) => r.principal_id);
    expect(ids).toContain(managerB);
    expect(ids).not.toContain(managerA);
    await withTenant(
      db.rw,
      ctx(f.seed.system),
      (tx) =>
        tx`update app.role_assignment set expires_at=now()-interval '1 day' where principal_id=${managerB}`,
    );
    expect((await read()).map((r) => r.principal_id)).not.toContain(managerB);
  });
});
