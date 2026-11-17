import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  postInventoryDocument,
  recordingJobs,
  STOCK_ISSUE_COST_POLICY,
  STOCK_RECEIPT_COST_POLICY,
} from "../../../../tests/invariants/support/post-inventory";
import { MOVEMENTS_PER_BATCH, replay } from "../../src/costing/replay";
import { loadDocumentTypes } from "../../src/seed/document-types";
import {
  grantCodes,
  seedDocumentType,
  seedItem,
  seedTenantV2,
  seedWarehouse,
  type Seed,
} from "../fixtures";
import { startDb, uuidv7, withTenant, type Db } from "../harness";

/** Twelve months of alternating receipt and issue, one document each, all 2026. */
const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-05`);
/** Resolved from this file: Vitest runs this package from `packages/db`, so a bare relative pack path
 *  would resolve to `packages/db/packages/db/seed/…` (1a:5114 does the same). */
const TYPES = fileURLToPath(new URL("../../seed/my/document-types", import.meta.url));

describe("acceptance test 5 — back-dated costing (spec:2423; LEGACY-004, 005, 010)", () => {
  let db: Db;
  let s: Seed;
  let receiptType: string;
  let issueType: string;
  let itemId: string;
  let warehouseId: string;
  let catalogue: string[];

  beforeAll(async () => {
    db = await startDb();
    s = await seedTenantV2(db, "Replay");
    // `grantCodes(db, s)` with no `codes` grants NOTHING (its docstring), and 2B's R2 evaluates both
    // fixture policies' `approval.post` inside the posting transaction.
    await grantCodes(db, s, { codes: ["accounting.journal.post"] });
    // The permission catalogue as DATA, read from the table: `packages/db` may not import
    // `@dulja/contracts` (0B's `dependency-rule`; 1a:5105 spells out this exact substitution).
    // `app.permission` is global, carries no `tenant_id` and no RLS (plan0A:1313), migration 0014 is its
    // only writer, and `permission-catalogue.test.ts` pins it equal to `PERMISSIONS` in both directions —
    // so the two sources cannot disagree. 1A's loader suite reads it the same way (1a:5131–5132), and
    // `no-bare-db` allows `db.admin` under `packages/db/test/` (0b:4969).
    catalogue = (await db.admin<{ code: string }[]>`select code from app.permission`).map(
      (r) => r.code,
    );
    // 3A's `seedItem` (called below) idempotently seeds 1300, 5000 and 5900 — the whole chart this slice
    // resolves. No `seedAccount` call is needed and none is made: 0C owns those rows (hazard 33).
    //
    // `loadDocumentTypes` takes a POOL and opens its own `withTenant` (src/seed/document-types.ts:45), so it
    // is called directly. Wrapping it in the harness's `withTenant` hands it a transaction, and the
    // production `withTenant` refuses one with ERR_TENANT_CONTEXT_NESTED.
    await loadDocumentTypes(
      db.migrator,
      { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) },
      TYPES,
      catalogue,
    );
    receiptType = await seedDocumentType(db, s, {
      code: "STOCK_RECEIPT_TEST",
      module: "inventory",
      policy: STOCK_RECEIPT_COST_POLICY,
    });
    issueType = await seedDocumentType(db, s, {
      code: "STOCK_ISSUE_TEST",
      module: "inventory",
      policy: STOCK_ISSUE_COST_POLICY,
    });
    // trackLots: false — `seedItem` defaults it to TRUE (§4.6.1) and `evaluatePolicy` refuses a DECLARED
    // receipt of a lot-tracked item whose line names no lot (ERR_POLICY_REQUIRES_MISSING). Every line below
    // is lot-less, as `valuation.test.ts` and `apply-movements.test.ts` are for the same reason.
    ({ itemId } = await seedItem(db, s, { code: "REPLAY-1", trackLots: false }));
    warehouseId = await seedWarehouse(db, s, { code: "R-WH" });

    // Twelve months: buy 100 @ 10 on the 5th, sell 100 on the 6th. Every month, same numbers.
    //
    // The issue drains its OWN month's receipt exactly, so in THIS forward build — before any back-dating —
    // each month closes at zero on hand and no residue carries into the next. (Once the 2026-03-03 receipt
    // arrives, March leaves 100 units of residue and every later month carries some; the figures below are
    // derived from the layer sets that actually result, not from the zero-residue rule.) That is what makes
    // March's arithmetic a two-layer average a reader can check by hand instead of a twelve-term
    // proportional chain, and it is the whole reason the quantities are 100/100 rather than 100/50.
    //
    // The issue date is BUILT, never produced by `day.replace("-05", "-06")`: `String.prototype.replace`
    // with a string pattern replaces the FIRST occurrence, and for `2026-05-05` the first `-05` is the
    // MONTH — so May's issue would land on 2026-06-05, May would get no issue at all and June would get two
    // in one period. Every count in this suite (10, 10, 9, 8) would then be one short.
    const jobs = recordingJobs();
    for (const day of MONTHS) {
      const issueDay = `${day.slice(0, 8)}06`; // "2026-05-05" → "2026-05-06"
      await postInventoryDocument(db, s, {
        documentTypeId: receiptType,
        warehouseId,
        jobs,
        effectiveDate: day,
        lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "10.0000" }],
      });
      await postInventoryDocument(db, s, {
        documentTypeId: issueType,
        warehouseId,
        jobs,
        effectiveDate: issueDay,
        lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "40.0000" }],
      });
    }
    // strictly forward so far — nothing to replay (each post enqueues 4B's accounting.projection.rebuild)
    expect(jobs.enqueued.filter((j) => j.name === "inventory.cost.replay")).toEqual([]);
  }, 600_000);
  afterAll(async () => {
    await db.stop();
  });

  it("MOVEMENTS_PER_BATCH is 500, so a replay is many short transactions (spec:1368)", () => {
    expect(MOVEMENTS_PER_BATCH).toBe(500);
  });

  it("a purchase back-dated into month 3 recomputes months 3-12 and leaves months 1-2 untouched", async () => {
    const before = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string; created_at: string; effective_at: string }[]>`
        select l.id::text as id, l.created_at::text as created_at, l.effective_at::text as effective_at
          from app.cost_layer l where l.company_id = ${s.company} order by l.effective_at`,
    );
    const early = before.filter((r) => r.effective_at < "2026-03-01");
    expect(early).toHaveLength(2);

    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate: "2026-03-03",
      lines: [{ itemId, warehouseId, quantity: "100.000000", unitPrice: "30.0000" }],
    });
    expect(jobs.enqueued).toEqual([
      {
        name: "inventory.cost.replay",
        payload: { companyId: s.company },
        singletonKey: s.company,
      },
      // 4B (step 14, amendment 2): every document with movements also enqueues the projection rebuild.
      {
        name: "accounting.projection.rebuild",
        payload: { companyId: s.company },
        singletonKey: s.company,
      },
    ]);

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const result = await replay(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } },
      ctx,
    );

    // 1 back-dated receipt + (10 receipts + 10 issues) from March on = 21 movements at or after the key.
    expect(result.movementsReplayed).toBe(21);
    // TEN adjustments, one per (fiscal period, branch) whose COGS moved (amendment A16(a)). Ten issues were
    // recosted — March to December — and `ensureOpenPeriods` gives each month its own period, so each
    // period's COGS change posts in the period it belongs to. That is spec:2039 (`effective_date` is the
    // accounting date) applied to a correction, and it is why the count is ten and not one.
    expect(result.adjustmentsPosted).toHaveLength(10);
    const periods = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ fiscal_period_id: string }[]>`
        select distinct fiscal_period_id::text as fiscal_period_id from app.document
         where id = any(${result.adjustmentsPosted}::uuid[])`,
    );
    expect(periods).toHaveLength(10); // one per period — never two in one period

    // The proportional clause, asserted on ROWS and never on a wall clock: months 1-2 keep their ids,
    // their created_at and their valid state. Nothing before the invalidation point was rewritten.
    const after = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        { id: string; created_at: string; effective_at: string; invalidated_at: string | null }[]
      >`
        select l.id::text as id, l.created_at::text as created_at, l.effective_at::text as effective_at,
               l.invalidated_at::text as invalidated_at
          from app.cost_layer l
         where l.company_id = ${s.company} and l.effective_at < '2026-03-01' order by l.effective_at`,
    );
    expect(after.map((r) => ({ id: r.id, created_at: r.created_at }))).toEqual(
      early.map((r) => ({ id: r.id, created_at: r.created_at })),
    );
    expect(after.every((r) => r.invalidated_at === null)).toBe(true);

    // …and nothing anywhere is left invalid.
    const [left] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.cost_layer
         where company_id = ${s.company} and invalidated_at is not null`,
    );
    expect(left!.n).toBe(0);
  }, 600_000);

  it("every adjustment is visible, explained, balanced, and posted to 1300 against 5000", async () => {
    const cas = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<
        {
          id: string;
          series: string;
          status: string;
          notes: string | null;
          effective_date: string;
          debit: string;
          credit: string;
        }[]
      >`
        select d.id::text as id, d.series, d.status, d.notes, d.effective_date::text as effective_date,
               (select sum(base_debit)::text  from app.ledger_entry where document_id = d.id) as debit,
               (select sum(base_credit)::text from app.ledger_entry where document_id = d.id) as credit
          from app.document d
          join app.document_type t on t.id = d.document_type_id
         where t.code = 'COST_ADJUSTMENT' and d.company_id = ${s.company}
         order by d.effective_date`,
    );
    expect(cas).toHaveLength(10);
    for (const ca of cas) {
      expect(ca.series).toBe("CA");
      expect(ca.status).toBe("posted");
      expect(ca.debit).toBe(ca.credit); // sum(base_debit) = sum(base_credit), per document
      expect(ca.notes).toMatch(/cost replay adjustment/i);
      expect(ca.notes).toMatch(/recomputed from \d{4}-\d{2}-\d{2} forward/i);
    }
    // The first one carries March's date — the period the recomputation started in.
    expect(cas[0]!.effective_date.slice(0, 7)).toBe("2026-03");

    const legs = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ code: string; debit: string; credit: string }[]>`
        select a.code, l.base_debit::text as debit, l.base_credit::text as credit
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.document_id = ${cas[0]!.id} order by a.code`,
    );
    // The whole March figure, worked out against the layer set the fixture actually produces.
    //
    // Every month's issue of 100 drained that month's receipt of 100 in the forward build, so January's and
    // February's layers sit at qty_remaining 0 and `openLayersFor` (which filters `qty_remaining > 0`) does
    // not return them. (From March on the back-dated receipt leaves a residue, so this is a statement about
    // the two months BEFORE the invalidation point, not a standing property of the fixture.)
    // The layers open at the 2026-03-06 issue are therefore exactly two:
    //     the back-dated 2026-03-03 receipt   100.000000 @ 30.0000  = 3000.0000
    //     the monthly    2026-03-05 receipt   100.000000 @ 10.0000  = 1000.0000
    // so `average` is (100×30 + 100×10) ÷ 200 = 20.0000, and the issue of 100 costs 2000.0000 where it had
    // cost 1000.0000. COGS is debited the 1000.0000 difference and inventory control is credited it.
    expect(legs).toEqual([
      { code: "1300", debit: "0.0000", credit: "1000.0000" },
      { code: "5000", debit: "1000.0000", credit: "0.0000" },
    ]);
  });

  it("a second replay over an unchanged company is a no-op — no movements, no adjustment (idempotent)", async () => {
    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const again = await replay(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } },
      ctx,
    );
    expect(again).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });
  });

  it("re-running after a completed run adds nothing, and no period gets two adjustments (LEGACY-054)", async () => {
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate: "2026-04-02",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "50.0000" }],
    });

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    // The observable state a restart reaches after its last committed batch: run the real function to
    // completion, then run it again. A restart mid-run is the same shape, because every batch commits and
    // the resume point is re-derived from committed rows rather than carried in memory (ADR 0038 note 4).
    const first = await replay(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } },
      ctx,
    );
    expect(first.movementsReplayed).toBeGreaterThan(0);
    expect(first.adjustmentsPosted).toHaveLength(9); // April to December — nine periods moved
    const second = await replay(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } },
      ctx,
    );
    expect(second).toEqual({ movementsReplayed: 0, adjustmentsPosted: [] });

    // THIS RUN posts at most one adjustment per period. (Across runs a period legitimately accumulates
    // several — one per back-dated document that reached it, each a separate, reversible entry.)
    const perPeriod = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ fiscal_period_id: string; n: number }[]>`
        select fiscal_period_id::text as fiscal_period_id, count(*)::int as n
          from app.document where id = any(${first.adjustmentsPosted}::uuid[])
         group by 1 having count(*) > 1`,
    );
    expect(perPeriod).toEqual([]);

    // The double-count guard of ADR 0038 note 5, stated as a figure: April's second adjustment is the
    // change since run 1's answer, not since the original posting.
    //
    // Run 1 left March's issue taking 50 from each of its two layers, so April opened on
    //     2026-03-03 layer  50.000000 @ 30.0000 = 1500.0000
    //     2026-03-05 layer  50.000000 @ 10.0000 =  500.0000
    //     2026-04-05 layer 100.000000 @ 10.0000 = 1000.0000
    // → 3000.0000 over 200.000000 = 15.0000, so run 1 moved April's COGS from 1000.0000 to 1500.0000.
    // The 10 @ 50.0000 receipt dated 2026-04-02 adds a fourth open layer, giving
    //     (50×30 + 50×10 + 10×50 + 100×10) ÷ 210 = 3500.0000 ÷ 210.000000 = 16.6667,
    // so April's issue of 100 reduces exact layer values by 1666.6666 and the delta is 166.6666 — not 666.6666, which is what
    // a "since the original posting" comparison would have produced.
    const [april] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ debit: string }[]>`
        select l.base_debit::text as debit
          from app.ledger_entry l join app.account a on a.id = l.account_id
         where l.document_id = any(${first.adjustmentsPosted}::uuid[]) and a.code = '5000'
           and (select effective_date from app.document where id = l.document_id) < '2026-05-01'`,
    );
    expect(april!.debit).toBe("166.6666");
  }, 600_000);

  it("qty_remaining equals qty_in minus its valid consumptions for every layer (the invariant the nightly check asserts)", async () => {
    const drift = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ id: string }[]>`
        select l.id::text as id from app.cost_layer l
         where l.company_id = ${s.company}
           and l.qty_remaining <> l.qty_in - coalesce((select sum(c.quantity) from app.cost_consumption c
                                                        where c.layer_id = l.id and c.invalidated_at is null), 0)`,
    );
    expect(drift).toEqual([]);
  });

  it("a closed affected period carries its adjustment forward and says so (test 9; amendment A16(b))", async () => {
    const jobs = recordingJobs();
    // POST FIRST, then close. `assert_period_open` refuses a post into a closed period, and this case is
    // about where the ADJUSTMENT lands, not about whether the source document could be entered.
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate: "2026-05-02",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "70.0000" }],
    });
    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`
        update app.fiscal_period set status = 'closed'
         where company_id = ${s.company} and starts_on = '2026-05-01'`,
    );

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const out = await replay(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } },
      ctx,
    );
    expect(out.adjustmentsPosted).toHaveLength(8); // May to December — eight periods moved

    const posted = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ effective_date: string; notes: string }[]>`
        select effective_date::text as effective_date, notes from app.document
         where id = any(${out.adjustmentsPosted}::uuid[]) order by effective_date`,
    );
    // May's own adjustment cannot post in May, so it lands in June beside June's — two CA documents dated
    // in June, distinguishable by their notes. Nothing is netted and nothing is lost.
    const carried = posted.filter((d) => /source period 2026-05 is closed/i.test(d.notes));
    expect(carried).toHaveLength(1);
    expect(carried[0]!.effective_date >= "2026-06-01").toBe(true);
    expect(posted.filter((d) => d.effective_date.slice(0, 7) === "2026-06")).toHaveLength(2);
  }, 600_000);

  it("with no open period on or after the affected one, the job records an incident and returns", async () => {
    // The shape a replay finds after an operator closes the rest of the year between the enqueue and the
    // run: BACK-DATE FIRST, while July is still open, then close June onward, then replay.
    //
    // The obvious alternative — `update app.cost_consumption set invalidated_at = now()` by hand and replay
    // with nothing new posted — cannot produce an incident, and that is worth stating so nobody re-writes
    // it that way. The engine is pure and the layer set is unchanged, so a forward pass over invalidated-
    // but-otherwise-identical state recomputes byte-identical consumption values; the delta query's
    // `having sum(after_value - before_value) <> 0` then drops every group, and the run returns
    // `{ movementsReplayed: n, adjustmentsPosted: [] }` having reached no `target` lookup at all. A real
    // back-dated receipt is what makes the deltas non-zero and drives the job into note 6's branch.
    const jobs = recordingJobs();
    await postInventoryDocument(db, s, {
      documentTypeId: receiptType,
      warehouseId,
      jobs,
      effectiveDate: "2026-07-02",
      lines: [{ itemId, warehouseId, quantity: "10.000000", unitPrice: "90.0000" }],
    });
    expect(jobs.enqueued).toEqual([
      {
        name: "inventory.cost.replay",
        payload: { companyId: s.company },
        singletonKey: s.company,
      },
      // 4B (step 14, amendment 2): every document with movements also enqueues the projection rebuild.
      {
        name: "accounting.projection.rebuild",
        payload: { companyId: s.company },
        singletonKey: s.company,
      },
    ]);

    await withTenant(
      db.migrator,
      s.tenant,
      s.system,
      (tx) => tx`
        update app.fiscal_period set status = 'closed'
         where company_id = ${s.company} and starts_on >= '2026-06-01'`,
    );

    const ctx = { tenantId: s.tenant, actorId: s.system, requestId: await uuidv7(db.admin) };
    const out = await replay(
      db.rw,
      { tenantId: s.tenant, requestId: ctx.requestId, payload: { companyId: s.company } },
      ctx,
    );
    // July to December all moved, and every one of those six periods is now closed with no open period
    // after it — so the layers are rewritten and NOTHING is posted. Not "fewer than eight": none.
    expect(out.adjustmentsPosted).toEqual([]);
    expect(out.movementsReplayed).toBeGreaterThan(0);

    const [incident] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from app.audit_log where table_name = 'integrity_incident'`,
    );
    // Six, derived rather than guessed: the delta query's `replayed` CTE requires an invalidated
    // consumption generation, so the 2026-07-02 RECEIPT contributes nothing and the six issues of
    // 2026-07-06 … 2026-12-06 are the whole set — one (fiscal period, branch) group each, one branch, each
    // delta non-zero because the 10 @ 90.0000 layer moves every average from July onward.
    expect(incident!.n).toBe(6);

    // The operator's instruction is in the summary, by name — not a bare "replay failed". 1B writes the
    // whole IntegrityReport into `app.audit_log.after` (1b:1610-1614); the column is `after`, not `new_data`.
    const [row] = await withTenant(
      db.rw,
      s.tenant,
      s.human,
      (tx) => tx<{ after: { summary: string } }[]>`
        select after from app.audit_log where table_name = 'integrity_incident' order by seq desc limit 1`,
    );
    expect(row!.after.summary).toMatch(/no open fiscal period on or after 2026-\d{2}-\d{2}/);
    expect(row!.after.summary).toMatch(/accounting\.period\.reopen/);
  }, 600_000);
});
