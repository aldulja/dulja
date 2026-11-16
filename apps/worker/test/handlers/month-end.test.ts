import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "@dulja/contracts";
import { systemContext, withTenant, type IntegrityReport } from "@dulja/db";
import { seedTenantV2, startDb, uuidv7, type Db, type Seed } from "@dulja/db/test";
import { postJournal } from "../../../../tests/invariants/support/post-journal";
import { createMonthEndHandler } from "../../src/handlers/accounting";
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

describe("accounting.period.month_end handler (spec:1159, 2223)", () => {
  let db: Db;
  let a: Seed;
  const logs: LogLine[] = [];
  const raised: { kind: string; report: IntegrityReport }[] = [];
  const incident: IncidentReporter = {
    raise: (kind, report) => {
      raised.push({ kind, report });
    },
  };
  const handler = createMonthEndHandler({ logger: recordingLogger(logs), incident });

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
  });
  afterAll(async () => {
    await db.stop();
  });
  const jobCtx = async () => systemContext(db.rw, a.tenant, await uuidv7(db.admin));

  it("writes one month_end_ready audit row per overdue open period and closes nothing", async () => {
    await postJournal(db, a, [
      { account: a.cash, debit: "30.0000" },
      { account: a.sales, credit: "30.0000" },
    ]);
    const ctx = await jobCtx();
    logs.length = 0;
    raised.length = 0;
    await handler(
      db.rw,
      { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-04-01" } },
      ctx,
    );

    const rows = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ row_id: string; after: { ready: boolean; endsOn: string } }[]>`
      select row_id, after from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'month_end_ready' order by seq`,
    );
    // Only the OPEN period 2026-01 is due; closedPeriod (2026-02) and lockedPeriod (2026-03) are not open.
    expect(rows.map((row) => row.row_id)).toEqual([a.period]);
    expect(rows[0]!.after.ready).toBe(true);
    expect(rows[0]!.after.endsOn).toBe("2026-01-31");

    const [period] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ status: string }[]>`
      select status from app.fiscal_period where id = ${a.period}`,
    );
    expect(period!.status).toBe("open");
    expect(raised).toEqual([]);
  });

  it("does nothing for a period whose ends_on has not passed", async () => {
    const ctx = await jobCtx();
    const before = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant} and table_name = 'month_end_ready'`,
    );
    await handler(
      db.rw,
      { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-01-15" } },
      ctx,
    );
    const after = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.audit_log where tenant_id = ${a.tenant} and table_name = 'month_end_ready'`,
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("marks the period not ready, raises the incident, and still does not close it when a projection has drifted", async () => {
    const ctx = await jobCtx();
    await withTenant(
      db.rw,
      ctx,
      (tx) =>
        tx`update app.account_balance set base_credit = base_credit + 4 where account_id = ${a.sales}`,
    );
    logs.length = 0;
    raised.length = 0;
    await handler(
      db.rw,
      { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-04-01" } },
      ctx,
    );

    const [row] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ after: { ready: boolean; summary: string } }[]>`
      select after from app.audit_log
       where tenant_id = ${a.tenant} and table_name = 'month_end_ready' order by seq desc limit 1`,
    );
    expect(row!.after.ready).toBe(false);
    expect(row!.after.summary).toMatch(/^FAILED: /);
    expect(raised.map((entry) => entry.kind)).toEqual(["accounting.period.month_end"]);

    const [period] = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ status: string }[]>`
      select status from app.fiscal_period where id = ${a.period}`,
    );
    expect(period!.status).toBe("open");
    await withTenant(
      db.rw,
      ctx,
      (tx) =>
        tx`update app.account_balance set base_credit = base_credit - 4 where account_id = ${a.sales}`,
    );
  });
});
