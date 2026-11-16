import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkAuditChain,
  listPeriodReopens,
  recordIntegrityIncident,
  runIntegrityCheck,
  withTenant,
} from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "./support/post-journal";

describe("audit chain and the composed integrity check — test 13 as a job (spec:1963, 2246, 2179)", () => {
  let db: Db;
  let a: Seed;
  let empty: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    empty = await seedTenantV2(db, "Empty");
  });
  afterAll(async () => {
    await db.stop();
  });

  const ctxFor = async (seed: Seed) => ({
    tenantId: seed.tenant,
    actorId: seed.system,
    requestId: await uuidv7(db.admin),
  });

  it("walks a real chain and reports it intact", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "12.0000" },
      { account: a.sales, credit: "12.0000" },
    ]);
    const result = await withTenant(db.rw, await ctxFor(a), (tx) => checkAuditChain(tx, a.tenant));
    expect(result.brokenLinks).toBe(0);
    expect(result.badHashes).toBe(0);
    expect(result.firstBrokenSeq).toBeNull();
    expect(result.rows).toBeGreaterThan(0);
  });

  it("names the first bad row when a hash is tampered with", async () => {
    const ctx = await ctxFor(a);
    const [target] = await withTenant(
      db.migrator,
      ctx,
      (tx) => tx<{ seq: number }[]>`
      select seq::int as seq from app.audit_log where tenant_id = ${a.tenant} order by seq desc limit 1`,
    );
    // app_rw cannot UPDATE audit_log (0001 §8) and the *_immutable trigger refuses it for every role;
    // the only way to manufacture the failure is to disable the trigger as the table's owner, edit, and
    // put it back — which is exactly the attack the chain exists to detect.
    // Every statement below is a postgres.js TAGGED TEMPLATE, never sql.unsafe: contracts §3.3 gives
    // sql.unsafe exactly three homes (the migration runner, the pg-boss enqueue adapter, the Firebird
    // reader) and this is none of them. The two values that vary are bound parameters.
    await db.admin`alter table app.audit_log disable trigger audit_log_immutable`;
    await db.admin`update app.audit_log set after = ${'{"tampered":true}'}::jsonb where seq = ${target!.seq}`;
    await db.admin`alter table app.audit_log enable trigger audit_log_immutable`;

    const result = await withTenant(db.rw, ctx, (tx) => checkAuditChain(tx, a.tenant));
    expect(result.badHashes).toBe(1);
    expect(result.firstBrokenSeq).toBe(target!.seq);

    await db.admin`alter table app.audit_log disable trigger audit_log_immutable`;
    await db.admin`delete from app.audit_log where seq = ${target!.seq}`;
    await db.admin`alter table app.audit_log enable trigger audit_log_immutable`;
  });

  it("a deleted row breaks the link of its successor", async () => {
    const ctx = await ctxFor(a);
    const rows = await withTenant(
      db.migrator,
      ctx,
      (tx) => tx<{ seq: number }[]>`
      select seq::int as seq from app.audit_log where tenant_id = ${a.tenant} order by seq desc limit 3`,
    );
    const victim = rows[1]!.seq;
    await db.admin`alter table app.audit_log disable trigger audit_log_immutable`;
    await db.admin`delete from app.audit_log where seq = ${victim}`;
    await db.admin`alter table app.audit_log enable trigger audit_log_immutable`;
    const result = await withTenant(db.rw, ctx, (tx) => checkAuditChain(tx, a.tenant));
    expect(result.brokenLinks).toBe(1);
    expect(result.firstBrokenSeq).toBe(rows[0]!.seq);
  });

  it("reports every period reopen with its actor", async () => {
    const ctx = await ctxFor(a);
    await withTenant(
      db.rw,
      { ...ctx, actorId: a.human },
      (tx) => tx`update app.fiscal_period set status = 'closed' where id = ${a.period}`,
    );
    await withTenant(
      db.rw,
      { ...ctx, actorId: a.human },
      (
        tx,
      ) => tx`update app.fiscal_period set status = 'open', reopen_reason = 'reopened for the reopen report'
                  where id = ${a.period}`,
    );
    const reopens = await withTenant(db.rw, ctx, (tx) =>
      listPeriodReopens(tx, { tenantId: a.tenant }),
    );
    expect(reopens).toHaveLength(1);
    expect(reopens[0]).toMatchObject({
      fiscalPeriodId: a.period,
      fromStatus: "closed",
      toStatus: "open",
      actorId: a.human,
    });
  });

  it("reports 'no postings' for a tenant with an empty ledger, and that is not a failure (spec:2321)", async () => {
    const ctx = await ctxFor(empty);
    const report = await withTenant(db.rw, ctx, (tx) => runIntegrityCheck(tx, ctx));
    expect(report.summary).toBe("no postings");
    expect(report.ok).toBe(true);
    // Second of the three assertions §4.16.3 pins — see the note on the first, in
    // tests/invariants/projection-rebuild.test.ts. 2B moves all three together.
    // 2B registers SERIES_GAP_CHECK beside 1B's ACCOUNT_BALANCE_CHECK (contracts §4.16.3); registration order
    // is the array's order. An empty-ledger tenant has no counters either, so `ok` and `summary` are unchanged.
    // 3A registers STOCK_ON_HAND_CHECK as the third, 3B's COST_LAYER_CHECK is the fourth (amendment
    // A10) and 4B's ITEM_PROFITABILITY_CHECK the fifth (ADR 0046); projectionChecks() sorts by name.localeCompare, so the array is alphabetical and stable
    // whatever order the registrations run in.
    expect(report.projections.checked).toEqual([
      "account_balance",
      "cost_layer",
      "document_series",
      "employee_ytd",
      "item_profitability",
      "stock_on_hand",
    ]);
    expect(report.auditChain.rows).toBeGreaterThan(0);
  });

  it("composes a failing report and records an incident without repairing anything", async () => {
    const ctx = await ctxFor(a);
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`
      update app.account_balance set base_credit = base_credit + 2 where account_id = ${a.sales}`,
    );
    const report = await withTenant(db.rw, ctx, (tx) => runIntegrityCheck(tx, ctx));
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/^FAILED: /);
    expect(report.projections.mismatches.map((mismatch) => mismatch.side)).toContain(
      "amount_differs",
    );

    await withTenant(db.rw, ctx, (tx) => recordIntegrityIncident(tx, report));
    const [row] = await withTenant(
      db.rw,
      ctx,
      (tx) =>
        tx<
          { table_name: string; row_id: string; actor_id: string; after: { ok: boolean } }[]
        >`select table_name, row_id, actor_id::text, after from app.audit_log
         where tenant_id = ${a.tenant} and table_name = 'integrity_incident' order by seq desc limit 1`,
    );
    expect(row!.row_id).toBe(ctx.requestId);
    expect(row!.actor_id).toBe(a.system);
    expect(row!.after.ok).toBe(false);

    const still = await withTenant(db.rw, ctx, (tx) => runIntegrityCheck(tx, ctx));
    expect(still.projections.mismatches.map((mismatch) => mismatch.side)).toContain(
      "amount_differs",
    );
  });
});
