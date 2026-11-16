import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant, verifyChain } from "@dulja/db";
import { seedTenant, seedEmployee, seedCashier, uuidv7, type Seed } from "@dulja/db/test";
import { startWorker, type StartedWorker } from "../support/worker";
let w: StartedWorker;
let s: Seed;
let cashier: string;
let serial = 0;
beforeAll(async () => {
  w = await startWorker();
}, 180_000);
afterAll(async () => w.stop());
beforeEach(async () => {
  s = await seedTenant(w.db, `COMPARE-${serial++}`);
  const employeeId = await seedEmployee(w.db, s, { employeeNumber: "COMPARE" });
  cashier = await seedCashier(w.db, s, {
    employeeId,
    branchId: s.hq,
    permissions: ["pos.ticket.sell"],
  });
  w.logs.length = 0;
});
const run = (companyId?: string) =>
  w.run("pos.cashier.compare", {
    tenantId: s.tenant,
    requestId: crypto.randomUUID(),
    payload: companyId ? { companyId } : {},
  });
// Test-only corruption proves the comparison detects a broken projection; production has one writer.
const corrupt = () =>
  withTenant(
    w.db.migrator,
    { tenantId: s.tenant, actorId: s.system, requestId: "simulate-trigger-fault" },
    (tx) =>
      tx`update app.pos_cashier set snapshot='{"codes":[],"limits":{}}'::jsonb where principal_id=${cashier}`,
  );
const audits = () =>
  withTenant(
    w.db.rw,
    { tenantId: s.tenant, actorId: s.system, requestId: "audit-proof" },
    (tx) =>
      tx<
        {
          actor_id: string;
          row_id: string;
          before: { codes: string[]; limits: unknown };
          after: { codes: string[]; limits: unknown };
        }[]
      >`select actor_id,row_id,"before","after" from app.audit_log where table_name='cashier_snapshot_drift'`,
  );
describe("pos.cashier.compare", () => {
  it("a healthy snapshot reports agreement without any drift audit row", async () => {
    await run();
    expect(await audits()).toEqual([]);
    expect(
      w.logs.filter((l) => l.level === "info" && l.msg === "cashier snapshots agree"),
    ).toHaveLength(1);
  });
  it("records exactly one system-attributed audit containing corrupted and recomputed facts", async () => {
    await corrupt();
    await run();
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      row_id: cashier,
      actor_id: s.system,
      before: { codes: [], limits: {} },
      after: { codes: ["pos.ticket.sell"], limits: { maxVoidAmount: "0.0000" } },
    });
    const chain = await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "drift-chain" },
      (tx) => verifyChain(tx, s.tenant),
    );
    expect(chain.rows).toBeGreaterThan(0);
    expect(chain.brokenLinks).toBe(0);
    expect(chain.badHashes).toBe(0);
    expect(
      w.logs.filter((l) => l.level === "warn" && l.msg.startsWith("cashier snapshot drift")),
    ).toHaveLength(1);
  });
  it("reports the fault without repairing the stored projection", async () => {
    await corrupt();
    await run();
    const [row] = await withTenant(
      w.db.rw,
      { tenantId: s.tenant, actorId: s.system, requestId: "stored-proof" },
      (tx) =>
        tx<
          { snapshot: { codes: string[]; limits: unknown } }[]
        >`select snapshot from app.pos_cashier where principal_id=${cashier}`,
    );
    expect(row?.snapshot.codes).toEqual([]);
    expect(row?.snapshot.limits).toEqual({});
    expect(await audits()).toHaveLength(1);
  });
  it("narrows the scan to the supplied company within the same tenant", async () => {
    const company = await uuidv7(w.db.admin),
      branchType = await uuidv7(w.db.admin),
      hq = await uuidv7(w.db.admin);
    await withTenant(
      w.db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: "company-fixture" },
      async (tx) => {
        await tx`insert into app.company(id,tenant_id,code,name,base_currency) values(${company},${s.tenant},'OTHER','Other','MYR')`;
        await tx`insert into app.dimension_type(id,tenant_id,company_id,code,name_en) values(${branchType},${s.tenant},${company},'BRANCH','Branch')`;
        await tx`insert into app.dimension_value(id,tenant_id,dimension_type_id,code,name_en) values(${hq},${s.tenant},${branchType},'HQ','HQ')`;
      },
    );
    await corrupt();
    await run(company);
    expect(await audits()).toEqual([]);
    await run(s.company);
    expect(await audits()).toHaveLength(1);
  });
  it("reports the current tenant while preserving another tenant's exact snapshot and audits", async () => {
    const victim = await seedTenant(w.db, `COMPARE-VICTIM-${serial++}`);
    const employeeId = await seedEmployee(w.db, victim, { employeeNumber: "VICTIM" });
    const victimCashier = await seedCashier(w.db, victim, {
      employeeId,
      branchId: victim.hq,
      permissions: ["pos.ticket.sell"],
    });
    await withTenant(
      w.db.migrator,
      { tenantId: victim.tenant, actorId: victim.system, requestId: "victim-fault" },
      (tx) =>
        tx`update app.pos_cashier set snapshot='{"codes":[],"limits":{}}'::jsonb where principal_id=${victimCashier}`,
    );
    const readVictim = () =>
      w.db
        .admin`select snapshot,revision::text from app.pos_cashier where principal_id=${victimCashier}`;
    const before = await readVictim();
    await corrupt();
    await run();
    expect(await readVictim()).toEqual(before);
    const [count] = await w.db.admin<
      { n: number }[]
    >`select count(*)::int as n from app.audit_log where tenant_id=${victim.tenant} and table_name='cashier_snapshot_drift'`;
    expect(count?.n).toBe(0);
    expect(await audits()).toHaveLength(1);
  });
});
