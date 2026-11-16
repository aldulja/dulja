import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "@dulja/contracts";
import { postDocument, systemContext, withTenant, type TenantContext } from "@dulja/db";
import {
  grantCodes,
  draftDocument,
  seedTenantV2,
  startDb,
  uuidv7,
  type Db,
  type Seed,
} from "@dulja/db/test";
import { createMonthEndHandler } from "../../apps/worker/src/handlers/accounting";
import { postJournal } from "./support/post-journal";

/**
 * Two matchers, deliberately, because two different pieces of code raise this condition.
 *
 * TRIGGER_LOCKED is migration 0001's exact text — `raise exception 'ERR_PERIOD_NOT_OPEN: period % is %'`
 * (0001_create_core_schema.sql:453) — and is asserted only against a direct insert into app.ledger_entry,
 * where app.assert_period_open() is demonstrably the raiser.
 *
 * refusedFor(id) is for the cases that go through postDocument, whose §4.3.2 step-5 pre-check raises
 * ERR_PERIOD_NOT_OPEN through PostingError with a human message 1A writes; that message is 1A's to phrase
 * and this slice must not pin another slice's wording. It still asserts everything spec:2051 demands —
 * the stable code, and a message naming the specific entity by its id — without asserting the phrasing
 * between them. Neither matcher may be weakened to a bare /ERR_PERIOD_NOT_OPEN/.
 */
const TRIGGER_LOCKED = /ERR_PERIOD_NOT_OPEN: period [0-9a-fA-F-]{36} is locked/;
const refusedFor = (periodId: string): RegExp =>
  new RegExp(`ERR_PERIOD_NOT_OPEN[\\s\\S]*${periodId}`);

const noop = (): void => undefined;
const silentLogger = ((): Logger => {
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
})();

describe("period lock — acceptance test 9, the background-job path (spec:2427; LEGACY-031, 041)", () => {
  let db: Db;
  let a: Seed;

  beforeAll(async () => {
    db = await startDb();
    a = await seedTenantV2(db, "Alpha");
    await grantCodes(db, a, { codes: ["accounting.journal.post"] });
  });
  afterAll(async () => {
    await db.stop();
  });

  const humanCtx = async (): Promise<TenantContext> => ({
    tenantId: a.tenant,
    actorId: a.human,
    requestId: await uuidv7(db.admin),
  });
  const jobCtx = async (): Promise<TenantContext> =>
    systemContext(db.rw, a.tenant, await uuidv7(db.admin));

  /** A draft with two balanced lines, dated into `periodId`, ready to be posted (or refused). */
  async function draftInto(periodId: string, effectiveDate: string): Promise<string> {
    const documentId = await draftDocument(db, a, { effectiveDate, periodId });
    await withTenant(db.rw, await humanCtx(), async (tx) => {
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
               values (${a.tenant}, ${a.company}, ${documentId}, 1, ${a.cash}, 9.0000, 0)`;
      await tx`insert into app.document_line (tenant_id, company_id, document_id, line_no, account_id, debit, credit)
               values (${a.tenant}, ${a.company}, ${documentId}, 2, ${a.sales}, 0, 9.0000)`;
    });
    return documentId;
  }

  it("the human path is refused (1A's path, re-run here as the control)", async () => {
    const documentId = await draftInto(a.lockedPeriod, "2026-03-10");
    const ctx = await humanCtx();
    await expect(
      withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })),
    ).rejects.toThrow(refusedFor(a.lockedPeriod));
  });

  it("the JOB path is refused at the posting service's pre-check, even as the system principal", async () => {
    const documentId = await draftInto(a.lockedPeriod, "2026-03-11");
    const ctx = await jobCtx();
    expect(ctx.actorId).toBe(a.system);
    await expect(
      withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })),
    ).rejects.toThrow(refusedFor(a.lockedPeriod));
  });

  it("the JOB path is refused by the TRIGGER when the posting service is bypassed entirely", async () => {
    // The pre-check above is a better error message; app.assert_period_open() is the control (0001:457).
    // This writes ledger_entry directly as app_rw under the system principal — the shape a future job
    // would have if someone ever wrote one that did not go through postDocument.
    const documentId = await draftInto(a.period, "2026-01-12");
    const ctx = await jobCtx();
    await expect(
      withTenant(
        db.rw,
        ctx,
        (tx) => tx`
      insert into app.ledger_entry (tenant_id, company_id, document_id, line_no, account_id, debit, credit,
                                    currency, exchange_rate, base_debit, base_credit, effective_date,
                                    fiscal_period_id, posting_policy_id)
      values (${a.tenant}, ${a.company}, ${documentId}, 1, ${a.cash}, 9.0000, 0, 'MYR', 1, 9.0000, 0,
              '2026-03-11', ${a.lockedPeriod}, ${a.policy})`,
      ),
    ).rejects.toThrow(TRIGGER_LOCKED);
  });

  it("a CLOSED period refuses writes exactly as a locked one does — the trigger tests `is distinct from open`", async () => {
    const documentId = await draftInto(a.closedPeriod, "2026-02-10");
    const ctx = await jobCtx();
    await expect(
      withTenant(db.rw, ctx, (tx) => postDocument(tx, ctx, { documentId })),
    ).rejects.toThrow(refusedFor(a.closedPeriod));
  });

  it("the month-end job cannot alter a locked or closed period — it reports and stops (spec:2223)", async () => {
    const ctx = await jobCtx();
    const handler = createMonthEndHandler({
      logger: silentLogger,
      incident: { raise: () => undefined },
    });
    const before = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ id: string; status: string }[]>`
      select id::text, status from app.fiscal_period where company_id = ${a.company} order by starts_on`,
    );
    const entriesBefore = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id in (${a.closedPeriod}, ${a.lockedPeriod})`,
    );

    await handler(
      db.rw,
      { tenantId: a.tenant, requestId: ctx.requestId, payload: { asOf: "2026-06-01" } },
      ctx,
    );

    const after = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ id: string; status: string }[]>`
      select id::text, status from app.fiscal_period where company_id = ${a.company} order by starts_on`,
    );
    const entriesAfter = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id in (${a.closedPeriod}, ${a.lockedPeriod})`,
    );

    expect(after).toEqual(before);
    expect(entriesAfter).toEqual(entriesBefore);
  });

  it("the only remedy is a reversing entry in an OPEN period, and it leaves the locked period untouched", async () => {
    const ctx = await jobCtx();
    const before = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id = ${a.lockedPeriod}`,
    );
    await postJournal(
      db,
      a,
      [
        { account: a.sales, debit: "9.0000" },
        { account: a.cash, credit: "9.0000" },
      ],
      { effectiveDate: "2026-01-25", periodId: a.period, actorId: a.human },
    );
    const after = await withTenant(
      db.rw,
      ctx,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from app.ledger_entry where fiscal_period_id = ${a.lockedPeriod}`,
    );
    expect(after).toEqual(before);
  });
});
