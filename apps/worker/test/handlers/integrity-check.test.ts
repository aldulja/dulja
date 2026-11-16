import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "@dulja/contracts";
import { systemContext, withTenant, type IntegrityReport } from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "../../../../tests/invariants/support/post-journal";
import { createIntegrityCheckHandler } from "../../src/handlers/accounting";
import type { IncidentReporter } from "../../src/observability/incident";

interface LogLine {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
}

function recordingLogger(sink: LogLine[]): Logger {
  const push =
    (level: string) =>
    (fields: Record<string, unknown>, msg: string): void => {
      sink.push({ level, fields, msg });
    };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => logger,
  };
  return logger;
}

describe("accounting.ledger.integrity_check handler (spec:2246; §5.0 row 0.11)", () => {
  let db: Db;
  let a: Seed;
  const logs: LogLine[] = [];
  const raised: { kind: string; report: IntegrityReport }[] = [];
  const incident: IncidentReporter = {
    raise: (kind, report) => {
      raised.push({ kind, report });
    },
  };
  const handler = createIntegrityCheckHandler({ logger: recordingLogger(logs), incident });

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });
  const jobCtx = async () => systemContext(db.rw, a.tenant, await uuidv7(db.admin));
  const envelope = (payload: { companyId?: string } = {}) => ({
    tenantId: a.tenant,
    requestId: "req",
    payload,
  });

  it("runs as the tenant's system principal and logs a pass on a clean ledger", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "20.0000" },
      { account: a.sales, credit: "20.0000" },
    ]);
    logs.length = 0;
    raised.length = 0;
    const ctx = await jobCtx();
    expect(ctx.actorId).toBe(a.system);
    await handler(db.rw, envelope(), ctx);
    expect(raised).toEqual([]);
    expect(logs.filter((line) => line.level === "error")).toEqual([]);
    expect(logs.at(-1)!.msg).toBe("ledger integrity check passed");
  });

  it("records an incident audit row, raises it, and logs an error when a projection has drifted", async () => {
    const ctx = await jobCtx();
    await withTenant(
      db.rw,
      ctx,
      (tx) =>
        tx`update app.account_balance set base_debit = base_debit + 7 where account_id = ${a.cash}`,
    );
    logs.length = 0;
    raised.length = 0;
    await handler(db.rw, envelope(), ctx);

    expect(raised).toHaveLength(1);
    expect(raised[0]!.kind).toBe("accounting.ledger.integrity_check");
    expect(raised[0]!.report.ok).toBe(false);
    // Contracts §4.16.3 pins this array by name and file: when 2B registers SERIES_GAP_CHECK it becomes
    // ["account_balance", "document_series"], and this line moves in that same PR.
    // 2B registers SERIES_GAP_CHECK beside ACCOUNT_BALANCE_CHECK; 3A adds STOCK_ON_HAND_CHECK as the third
    // and 3B's COST_LAYER_CHECK is the fourth (amendment A10); 4B's ITEM_PROFITABILITY_CHECK is the fifth
    // (ADR 0046); 8C's EMPLOYEE_YTD_CHECK the sixth (round 18 B5). projectionChecks() sorts by name, so it is stable.
    expect(raised[0]!.report.projections.checked).toEqual([
      "account_balance",
      "cost_layer",
      "document_series",
      "employee_ytd",
      "item_profitability",
      "stock_on_hand",
    ]);
    // The stub IncidentReporter above logs nothing, so the only error line is the handler's own —
    // createIncidentReporter's "integrity incident" line belongs to production wiring, not to this test.
    expect(logs.filter((line) => line.level === "error").map((line) => line.msg)).toEqual([
      "ledger integrity check failed",
    ]);

    const [row] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ row_id: string; actor_id: string }[]>`
      select row_id, actor_id::text from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'integrity_incident' order by seq desc limit 1`,
    );
    expect(row!.row_id).toBe(ctx.requestId);
    expect(row!.actor_id).toBe(a.system);

    await withTenant(
      db.rw,
      ctx,
      (tx) =>
        tx`update app.account_balance set base_debit = base_debit - 7 where account_id = ${a.cash}`,
    );
  });

  it("never writes to a projection — the drifted value survives the run that reported it", async () => {
    const ctx = await jobCtx();
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`update app.account_balance set credit = credit + 3 where account_id = ${a.sales}`,
    );
    await handler(db.rw, envelope(), ctx);
    const [row] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ credit: string }[]>`
      select credit::text from app.account_balance where account_id = ${a.sales}`,
    );
    expect(row!.credit).not.toBe("0.0000");
    await withTenant(
      db.rw,
      ctx,
      (tx) => tx`update app.account_balance set credit = credit - 3 where account_id = ${a.sales}`,
    );
  });

  it("logs a pass and raises nothing for a tenant with no postings (spec:2321)", async () => {
    const empty = await seedTenantV2(db, "Empty");
    const ctx = await systemContext(db.rw, empty.tenant, await uuidv7(db.admin));
    logs.length = 0;
    raised.length = 0;
    await handler(db.rw, { tenantId: empty.tenant, requestId: ctx.requestId, payload: {} }, ctx);
    expect(raised).toEqual([]);
    expect(logs.at(-1)!.fields["summary"]).toBe("no postings");
  });
});
