import {
  costingEngine,
  CostingError,
  Money,
  Quantity,
  type CostingMethod,
  type CurrencyCode,
  type Layer,
} from "@dulja/domain";
import type { Sql } from "postgres";
import { recordIntegrityIncident } from "../integrity";
// The file paths, never the `@dulja/db` barrel: `packages/db/src/index.ts` re-exports `./costing`, so the
// barrel would close an import cycle through this module (post.ts records the same rule).
import type { JobEnvelope } from "../jobs/enqueue";
import { PostingError } from "../posting/errors";
import { postDocument } from "../posting/post";
import { withTenant, type TenantContext } from "../with-tenant";
import { purchaseCancellation } from "./purchase-cancellation";
import { openLayersFor } from "./apply-movements";
import { lockTenantAuditSerial } from "./invalidate";
import { lockStockKeys } from "./stock-on-hand";
import { COST_ADJUSTMENT_CODE, resolveAdjustmentAccounts } from "./cost-adjustment";

/** spec:1368 — long jobs run as many short transactions, never one long one. */
export const MOVEMENTS_PER_BATCH = 500;

/** The contracts §4.3.5 chronological key, as a value. */
interface Key {
  effectiveDate: string;
  postingSeq: bigint;
  lineNo: number;
  movementNo: number;
}

/** `a < b` on the full four-column key — Postgres's row-wise `<`. ISO dates, so string order is date order. */
function precedes(a: Key, b: Key): boolean {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate;
  if (a.postingSeq !== b.postingSeq) return a.postingSeq < b.postingSeq;
  if (a.lineNo !== b.lineNo) return a.lineNo < b.lineNo;
  return a.movementNo < b.movementNo;
}

interface MovementRow {
  id: string;
  documentId: string;
  itemId: string;
  warehouseId: string;
  lotId: string;
  lineNo: number;
  movementNo: number;
  quantity: string;
  value: string;
  effectiveDate: string;
  postingSeq: string;
  layerId: string | null;
  layerQtyIn: string | null;
  /** For the receipt a reversal of an issue emits (§4.7.2 branch 1): the issue movement it mirrors. */
  mirrorOf: string | null;
  /** That issue's `document_line.cost` as this batch read it, and its quantity (a magnitude). */
  mirrorCost: string | null;
  mirrorQuantity: string | null;
}

/** The two sentences `document.notes` carries, assembled from parts rather than written as one interpolated
 *  template: `no-sql-concat` scans an untagged template literal that both interpolates and names a SQL
 *  keyword, and "Recomputed from <date>" names one. The wording is the wording acceptance test 5 pins. */
const NOTE_HEAD = "Cost replay adjustment. Recomputed ";
const NOTE_FROM = "from ";
const NOTE_FORWARD = " forward";

function adjustmentNotes(source: string, samePeriod: boolean): string {
  const head = [NOTE_HEAD, NOTE_FROM, source, NOTE_FORWARD].join("");
  if (samePeriod) return `${head}.`;
  return [
    head,
    "; source period ",
    source.slice(0, 7),
    " is closed, so this entry posts in the earliest open period on or after it.",
  ].join("");
}

/**
 * §4.7.2's job handler. Replays movements forward from the earliest invalidation in bounded batches,
 * rewrites layers and consumptions, and posts one `COST_ADJUSTMENT` per (fiscal period, branch) whose
 * COGS total moved (spec:1224). Idempotent and restartable (LEGACY-054): every write is a formula over
 * committed state, so a crash mid-run leaves the next run computing the same resume point.
 *
 * **Where the restart state lives (code review 2, C1 and C2; migration 0115).** Not in the consumption rows
 * the run itself rewrites: `app.cost_booking` holds, per issue movement, what the ledger carries for its cost
 * (`booked_value`) and whether that is settled (`pending`). `invalidateFrom` and step 2 mark a movement
 * `'recost'`; the forward pass moves each issue it recomputes to `'booking'` in the batch that recomputes it;
 * step 4 books `after − booked_value` and settles the row in the transaction that posts the adjustment. So a
 * run that recomputed a movement and could not book it — no open period, or a crash between steps 3 and 4 —
 * leaves the row at `'booking'` and the next run books it; and a generation with no consumption row at all is
 * remembered as the figure it was booked at rather than skipped over to an older one.
 *
 * Opens its OWN transactions — it is given `sql`, not a `tx` — because one transaction over twelve months
 * of movements would hold the per-tenant audit lock to commit (spec:1368). ADR 0038 records all six
 * behaviours this body depends on; none of them is implementation detail.
 *
 * **Lock order (code review 3, R1).** Every one of those transactions that locks a stock key or a cost row —
 * step 2, each step-3 batch, each step-4 group — takes the tenant's audit serialisation before the first lock
 * it takes (`lockTenantAuditSerial`; a batch after its first read, which locks nothing), because a poster holds
 * it from its first audited write, before any stock key or cost row it locks, to commit. Locking the rows first and meeting the audit lock at the first audited write
 * (a batch's `document_line.cost`, a group's COST_ADJUSTMENT) deadlocked with any poster that reached one of
 * those rows in between. Each transaction is short, so holding it from the start costs a poster one batch.
 */
export async function replay(
  sql: Sql,
  job: JobEnvelope<{ companyId: string }>,
  ctx: TenantContext,
): Promise<{ movementsReplayed: number; adjustmentsPosted: string[] }> {
  const companyId = job.payload.companyId;

  // ── 1. What needs work, and from where ──────────────────────────────────────────────────────────
  // "Needs work" is structural, never a boolean somebody remembered to set (LEGACY-005): a layer that is
  // invalidated, or an issue whose booking row says its consumption set must be recomputed (0115) — the
  // posting statements that invalidate a movement write that row. The third branch reads data written before
  // 0115, which has no booking row: there, as before, a movement whose only consumptions are invalidated.
  // A booking row that is settled or waiting to be booked is NOT needy, whatever its consumption rows look
  // like: a generation with no row at all (an issue no layer covered) looks exactly like an invalidated one,
  // and treating it as needy re-ran and re-booked it on every later replay (C2).
  const [scopeRow] = await withTenant(
    sql,
    ctx,
    (tx) => tx<
      {
        item_ids: string[] | null;
        effective_date: string | null;
        posting_seq: string | null;
        line_no: number | null;
        movement_no: number | null;
        unbooked: boolean;
      }[]
    >`
      with needy as (
        select m.item_id, m.effective_date, m.posting_seq, m.line_no, m.movement_no
          from app.inventory_movement m
          join app.cost_layer l on l.tenant_id = m.tenant_id and l.movement_id = m.id
         where m.company_id = ${companyId} and l.invalidated_at is not null
        union all
        select m.item_id, m.effective_date, m.posting_seq, m.line_no, m.movement_no
          from app.cost_booking b
          join app.inventory_movement m on m.tenant_id = b.tenant_id and m.id = b.movement_id
         where b.company_id = ${companyId} and b.pending = 'recost'
        union all
        select m.item_id, m.effective_date, m.posting_seq, m.line_no, m.movement_no
          from app.inventory_movement m
         where m.company_id = ${companyId}
           and exists (select 1 from app.cost_consumption c
                        where c.tenant_id = m.tenant_id and c.movement_id = m.id and c.invalidated_at is not null)
           and not exists (select 1 from app.cost_consumption c
                            where c.tenant_id = m.tenant_id and c.movement_id = m.id and c.invalidated_at is null)
           and not exists (select 1 from app.cost_booking b
                            where b.tenant_id = m.tenant_id and b.movement_id = m.id)
      )
      select array_agg(distinct item_id)                   as item_ids,
             min(effective_date)::text                     as effective_date,
             (select posting_seq::text from needy order by effective_date, posting_seq, line_no, movement_no limit 1) as posting_seq,
             (select line_no          from needy order by effective_date, posting_seq, line_no, movement_no limit 1) as line_no,
             (select movement_no      from needy order by effective_date, posting_seq, line_no, movement_no limit 1) as movement_no,
             exists (select 1 from app.cost_booking b
                      where b.company_id = ${companyId} and b.pending = 'booking') as unbooked
        from needy`,
  );

  // Destructured into locals rather than re-indexed: `noUncheckedIndexedAccess` types every element access
  // as possibly undefined, and one guard over one binding is narrower than five non-null assertions.
  const itemIds = scopeRow?.item_ids ?? [];
  // Named `start`, not `from`: `no-sql-concat` reads an interpolated `from` as constructed SQL, and this
  // value is interpolated into the statements below. Null when nothing needs recomputing — the run may still
  // have recomputed-but-unbooked movements to book (step 4).
  const start: Key | null =
    scopeRow &&
    itemIds.length > 0 &&
    scopeRow.effective_date !== null &&
    scopeRow.posting_seq !== null &&
    scopeRow.line_no !== null &&
    scopeRow.movement_no !== null
      ? {
          effectiveDate: scopeRow.effective_date,
          postingSeq: BigInt(scopeRow.posting_seq),
          lineNo: scopeRow.line_no,
          movementNo: scopeRow.movement_no,
        }
      : null;
  if (start === null && scopeRow?.unbooked !== true) {
    return { movementsReplayed: 0, adjustmentsPosted: [] };
  }

  // Resolved ONCE, before any arithmetic: a company whose chart lacks 1300 or 5000, or whose seed pack has
  // no COST_ADJUSTMENT row, fails at the top of the job rather than at an insert halfway through a batch.
  const accounts = await withTenant(sql, ctx, (tx) => resolveAdjustmentAccounts(tx, companyId));
  const company = (
    await withTenant(
      sql,
      ctx,
      (tx) => tx<{ base_currency: string; costing_method: string }[]>`
        select base_currency, costing_method from app.company where id = ${companyId}`,
    )
  )[0];
  if (!company) {
    throw new PostingError("ERR_NOT_FOUND", `no company ${companyId} in this tenant`);
  }
  const run: Run = {
    sql,
    ctx,
    companyId,
    itemIds,
    baseCurrency: company.base_currency as CurrencyCode,
    method: company.costing_method as CostingMethod,
  };

  const movementsReplayed = start === null ? 0 : await recompute(run, start);
  const adjustmentsPosted = await book(run, accounts, movementsReplayed);
  return { movementsReplayed, adjustmentsPosted };
}

/** What every step of one run shares. */
interface Run {
  sql: Sql;
  ctx: TenantContext;
  companyId: string;
  itemIds: string[];
  baseCurrency: CurrencyCode;
  method: CostingMethod;
}

/** Steps 2 and 3: re-invalidate from `start`, restore, and replay forward. Returns the movements replayed. */
async function recompute(run: Run, start: Key): Promise<number> {
  const { sql, ctx, companyId, itemIds, baseCurrency, method } = run;

  // ── 2. Re-invalidate, then restore. One transaction, in this order (ADR 0038 notes 4, 5) ────────
  // On the FULL chronological key, the same four columns steps 3 and 4 use. `start` can sit inside a
  // document — a run that died between two batches resumes at the first movement the dead batch did not
  // commit — and the two-part `(effective_date, posting_seq)` window then re-invalidated the document's
  // earlier lines, which the committed batch had already replayed and step 3 would not revisit: their
  // consumptions stayed invalid and their layers over-stated until yet another run (C1).
  await withTenant(sql, ctx, async (tx) => {
    // The audit lock before the first cost row (see `replay`'s lock-order note): this transaction writes no
    // audited row, but its UPDATEs lock layer, consumption and booking rows a poster's `invalidateFrom` also
    // locks, in whatever order each statement's scan meets them, and the poster holds the audit lock throughout.
    await lockTenantAuditSerial(tx, ctx.tenantId);
    // A document may have POSTED between `invalidateFrom` and this run. Its movement is at or after
    // `start` and carries a VALID consumption set, so the forward pass would insert a second valid set
    // beside it and the "before/after" arithmetic would compare a movement against itself. Re-running the
    // invalidation over the same window closes that window. It is idempotent: only rows that are still
    // valid get stamped. A document that posts AFTER this transaction commits is the forward pass's to
    // handle, and each batch re-establishes this state from its own cursor before it reads a layer (F4).
    await tx`
      update app.cost_layer l
         set invalidated_at = now()
        from app.inventory_movement m
       where m.tenant_id = l.tenant_id and m.id = l.movement_id
         and l.company_id = ${companyId}
         and l.item_id = any(${itemIds}::uuid[])
         and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
             >= (${start.effectiveDate}::date, ${start.postingSeq.toString()}::bigint, ${start.lineNo}::int, ${start.movementNo}::int)
         and l.invalidated_at is null`;
    await tx`
      update app.cost_consumption c
         set invalidated_at = now()
        from app.inventory_movement m
       where m.tenant_id = c.tenant_id and m.id = c.movement_id
         and m.company_id = ${companyId}
         and m.item_id = any(${itemIds}::uuid[])
         and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
             >= (${start.effectiveDate}::date, ${start.postingSeq.toString()}::bigint, ${start.lineNo}::int, ${start.movementNo}::int)
         and c.invalidated_at is null`;
    // Every issue in the window is now to be recomputed, and says so (0115) — so that a run that dies in
    // step 3 resumes no later than the first issue it had not reached, including one whose generation has
    // no consumption row to find it by. An issue first seen here starts from its immutable value, which is
    // what its own posting put on the ledger.
    await tx`
      insert into app.cost_booking as b (tenant_id, company_id, movement_id, booked_value, pending)
      select m.tenant_id, m.company_id, m.id, abs(m.value), 'recost'
        from app.inventory_movement m
       where m.company_id = ${companyId}
         and m.item_id = any(${itemIds}::uuid[])
         and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
             >= (${start.effectiveDate}::date, ${start.postingSeq.toString()}::bigint, ${start.lineNo}::int, ${start.movementNo}::int)
         and m.quantity < 0
      on conflict (tenant_id, movement_id) do update
         set pending = 'recost', updated_at = now()
       where b.pending is distinct from 'recost'`;
    // The restore pass — a formula, so a crash-restart re-runs it harmlessly (ADR 0038 note 4). A layer
    // BEFORE the invalidation point can have been consumed by a movement AFTER it: that consumption row is
    // now invalid, the layer's qty_remaining is stale, and the layer itself is not invalidated. Scoped to this
    // run's items: every consumption this run invalidated belongs to one of them, and re-deriving another
    // item's layers here, without that item's stock locks, would race its posters for nothing.
    await tx`
      update app.cost_layer l
         set qty_remaining = l.qty_in - coalesce((
               select sum(c.quantity) from app.cost_consumption c
                where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is null), 0)
       where l.company_id = ${companyId}
         and l.item_id = any(${itemIds}::uuid[])
         and exists (select 1 from app.cost_consumption c
                      where c.tenant_id = l.tenant_id and c.layer_id = l.id and c.invalidated_at is not null)`;
  });

  // ── 3. The forward pass, in bounded batches ─────────────────────────────────────────────────────
  let cursor = start;
  let movementsReplayed = 0;

  for (;;) {
    // The closure RETURNS its count and its next cursor rather than bumping outer state: `withTenant`
    // re-runs the closure once on a deadlock or serialization failure, and a counter incremented inside it
    // would count the retried batch twice.
    const batch = await withTenant(sql, ctx, async (tx) => {
      // Read, lock, and read AGAIN under the lock — until every stock key of the rows read is held. Every
      // stock key this batch touches is locked BEFORE the first layer read, with the same keys and in the
      // same order as postDocument step 9, so a document posted concurrently for one of these (item,
      // warehouse) pairs cannot consume a layer between our read and our absolute flush (Phase 3 review
      // pass). The second read is F4's: a document that COMMITTED between the first read and the lock is
      // not in the first read's rows, and its key can sit inside the batch's range — a batch spanning two
      // items runs past an ordinary post's date whenever the other item has later movements — so a cursor
      // taken from the first read would step over it and never cost it. Under the lock nothing more can
      // arrive for these pairs; a read that brings in a new pair locks it and reads once more. The locks
      // are transaction-scoped, so a concurrent poster waits at most one batch, not the whole replay.
      let rows = await readBatch(tx, companyId, itemIds, cursor);
      // The audit lock BEFORE the first lock this batch takes (see `replay`'s lock-order note), and after the
      // first read, which locks nothing: the stock keys, the re-invalidation, the restore and the booking marks
      // below all lock ahead of this batch's first audited write, the `document_line.cost` update, and a poster
      // of one of these pairs holds the audit lock while it waits for its stock key at postDocument step 9. A
      // document that commits between that read and this lock is what the read under the lock below is for.
      // It also covers the second lock round, which takes a newly read pair's key outside `lockStockKeys`'
      // sorted order: every other taker of a `stock:` key in this tenant — postDocument steps 9 and 12 — holds
      // this lock when it takes one, so none can hold a key this batch will wait for.
      await lockTenantAuditSerial(tx, ctx.tenantId);
      const locked = new Set<string>();
      for (;;) {
        const fresh = rows.filter((m) => !locked.has(`${m.itemId}/${m.warehouseId}/${m.lotId}`));
        if (fresh.length === 0) break;
        await lockStockKeys(
          tx,
          companyId,
          fresh.map((m) => ({ itemId: m.itemId, warehouseId: m.warehouseId, lotId: m.lotId })),
        );
        for (const m of fresh) locked.add(`${m.itemId}/${m.warehouseId}/${m.lotId}`);
        rows = await readBatch(tx, companyId, itemIds, cursor);
      }
      if (rows.length === 0) return null;

      // F4: re-establish, from THIS cursor, the state step 2 promises — every movement at or after it
      // without a valid consumption set, and every layer before it holding exactly what the movements
      // before it left. Step 2 ran once, in its own transaction; an ORDINARY post since then invalidates
      // nothing, so without this an issue posted after step 2 kept its post-time set VALID and this batch
      // inserted a second one beside it (step 4 then valued both as one generation). Scoped to this batch's
      // (item, warehouse) pairs, which are exactly the ones this transaction holds the layer locks for, and
      // keyed on all four columns: a cursor inside a document must not re-invalidate that document's earlier
      // lines, which the previous batch replayed and this one will not revisit.
      //
      // A receipt posted after step 2 is NOT invalidated here, only kept out of this batch's in-memory open
      // set until its own row is reached (below). Invalidating it would take its stock away from every poster
      // of its pair from this batch's commit until the batch that reaches it — a sale covered by stock on hand
      // refused ERR_STOCK_INSUFFICIENT, which the F5 owner question must not grow (code review 2
      // verification). Nothing needs it invalid: such a receipt is the latest movement of its item when it
      // posts (anything earlier is back-dated and runs `invalidateFrom`), so it sorts after every movement
      // step 2 marked, and a rerun that starts at the first of those reaches it.
      const pairs = [...new Map(rows.map((m) => [`${m.itemId}/${m.warehouseId}`, m])).values()];
      const pairItems = pairs.map((m) => m.itemId);
      const pairWarehouses = pairs.map((m) => m.warehouseId);
      const reopened = await tx<{ movement_id: string }[]>`
        update app.cost_consumption c
           set invalidated_at = now()
          from app.inventory_movement m
         where m.tenant_id = c.tenant_id and m.id = c.movement_id
           and m.company_id = ${companyId}
           and (m.item_id, m.warehouse_id) in (select * from unnest(${pairItems}::uuid[], ${pairWarehouses}::uuid[]))
           and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
               >= (${cursor.effectiveDate}::date, ${cursor.postingSeq.toString()}::bigint, ${cursor.lineNo}::int, ${cursor.movementNo}::int)
           and c.invalidated_at is null
        returning c.movement_id::text as movement_id`;
      // Step 2's restore formula — the invariant COST_LAYER_CHECK holds every valid layer to — over every layer
      // of this batch's pairs that an invalidated consumption at or after the cursor had reduced, whoever
      // invalidated it. Not only the ones the statement above returned: a back-dated post that commits after
      // step 2 runs `invalidateFrom`, which invalidates consumptions and never restores their layers (step 2
      // does that, and step 2 has already run). An ordinary issue posted after step 2 and then invalidated
      // that way is returned by nothing above, so a restore scoped to the returned rows left the layers it had
      // consumed short, costed the tail against them, and moved that post's marks to 'booking' — and the
      // replay the post enqueued then found nothing to do (code review 2 verification). Under this batch's
      // layer locks, and written only where the residue differs, so a pair with nothing stale writes nothing.
      await tx`
        update app.cost_layer l
           set qty_remaining = r.qty
          from (select s.id,
                       s.qty_in - coalesce((select sum(c.quantity) from app.cost_consumption c
                                             where c.tenant_id = s.tenant_id and c.layer_id = s.id
                                               and c.invalidated_at is null), 0) as qty
                  from app.cost_layer s
                 where s.company_id = ${companyId}
                   and (s.item_id, s.warehouse_id) in (select * from unnest(${pairItems}::uuid[], ${pairWarehouses}::uuid[]))
                   and exists (select 1 from app.cost_consumption c
                                 join app.inventory_movement m on m.tenant_id = c.tenant_id and m.id = c.movement_id
                                where c.tenant_id = s.tenant_id and c.layer_id = s.id and c.invalidated_at is not null
                                  and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
                                      >= (${cursor.effectiveDate}::date, ${cursor.postingSeq.toString()}::bigint, ${cursor.lineNo}::int, ${cursor.movementNo}::int))) r
         where l.id = r.id and l.qty_remaining <> r.qty`;
      if (reopened.length > 0) {
        // …and the movements this batch invalidated now say they are to be recomputed (0115), as step 2's
        // did. One `invalidateFrom` invalidated has its own mark already.
        await tx`
          insert into app.cost_booking as b (tenant_id, company_id, movement_id, booked_value, pending)
          select m.tenant_id, m.company_id, m.id, abs(m.value), 'recost'
            from app.inventory_movement m
           where m.company_id = ${companyId}
             and m.id = any(${[...new Set(reopened.map((r) => r.movement_id))]}::uuid[])
          on conflict (tenant_id, movement_id) do update
             set pending = 'recost', updated_at = now()
           where b.pending is distinct from 'recost'`;
      }

      let replayed = 0;
      // Thread the layer state in memory across the batch, exactly as applyMovements does — one read per
      // (item, warehouse), one write per touched layer at the end.
      const layerState = new Map<string, Layer[]>();
      const finalRemaining = new Map<string, Quantity>();
      /** Each issue this batch recomputed, by movement id, at its new value — what a later mirror is priced from. */
      const recostedIssues = new Map<string, Money>();
      /** The reversal receipts this batch re-priced from their issue (INV-02), to be booked beside the issues. */
      const repriced: string[] = [];

      for (const m of rows) {
        const key = `${m.itemId}/${m.warehouseId}`;
        if (!layerState.has(key)) {
          // Only the layers dated BEFORE the cursor are open when the pass arrives: a layer at or after it is
          // a receipt this pass has still to reach, and its own branch below opens it there. Step 2 invalidated
          // every such layer that existed when it ran; one posted since is valid (see above) and must not be
          // pushed into `open` ahead of its place — that averaged every earlier-dated issue over stock dated
          // after it (F4's case C). The first row of a pair in this batch is that pair's first movement at or
          // after the cursor, so the cursor and that row divide the pair's layers the same way.
          const loaded = await openLayersFor(tx, {
            companyId,
            itemId: m.itemId,
            warehouseId: m.warehouseId,
            baseCurrency,
          });
          layerState.set(
            key,
            loaded.filter((l) => precedes(l, cursor)),
          );
        }
        const open = layerState.get(key)!;
        const isIssue = m.quantity.startsWith("-");
        const magnitude = Quantity.of(isIssue ? m.quantity.slice(1) : m.quantity);
        const value = Money.of(m.value.startsWith("-") ? m.value.slice(1) : m.value, baseCurrency);

        if (!isIssue) {
          // `m.layerId` comes from a LEFT JOIN and is nullable, so the two conditions are split rather than
          // combined: a receipt with no layer row must NOT fall through to the issue branch below, which
          // would cost it against the layers, insert cost_consumption rows for a positive movement and
          // overwrite its document_line.cost with a consumption total. Such a row can only be a movement
          // posted by 3A's provisional body — which is exactly what Task 13's `reseed-verify` counts and
          // refuses to back-fill (§4.7.2) — so this raises and says which action to take.
          if (!m.layerId) {
            throw new PostingError(
              "ERR_INTERNAL",
              `replay: receipt movement ${m.id} has no cost_layer row; it was posted before this slice's applyMovements landed — re-seed rather than replay (contracts §4.7.2, Task 13 Step 7)`,
            );
          }
          // Its layer's unit_cost comes from the movement's own immutable value, so the recost restores the
          // layer and re-opens it. `unit_cost` is recomputed rather than trusted, because 3C's landed-cost
          // allocation is the one thing that legitimately changes a receipt's value.
          //
          // Except the receipt a reversal of an ISSUE emits (INV-02, ADR 0038's 2026-11-15 amendment). Its
          // value was copied from the issue's cost when the reversal posted (§4.7.2 branch 1): it is the issue's
          // cost, not a price of its own, so it follows the issue's CURRENT cost — the figure this batch just
          // computed when the issue is in it, and otherwise its `document_line.cost`, which a reversal always
          // follows (`reverseDocument` refuses a date before the original's) and which ADR 0038 note 2 keeps
          // current. Restored from its immutable value instead, the returned goods kept the stale cost, and the
          // recosted issue's difference stayed in COGS for a sale that was fully reversed. The layer's change
          // is booked against the ledger beside the issues' (`book`), so the pair nets to zero.
          let layerValue = value;
          if (m.mirrorOf !== null) {
            const source =
              recostedIssues.get(m.mirrorOf) ??
              (m.mirrorCost === null ? null : Money.of(m.mirrorCost, baseCurrency));
            if (source !== null) {
              const sourceQuantity = Quantity.of(m.mirrorQuantity ?? m.quantity);
              // A reversal mirrors the whole line, so the quantities agree and the issue's value is taken
              // whole; an unequal pair is priced at the issue's unit cost, as a transfer leg is (A7).
              layerValue =
                sourceQuantity.compare(magnitude) === 0
                  ? source
                  : source
                      .divide(sourceQuantity.toDecimal(), "HALF_AWAY_FROM_ZERO")
                      .multiply(magnitude.toDecimal(), "HALF_AWAY_FROM_ZERO");
              await tx`
                update app.document_line set cost = ${layerValue.toString()}
                 where document_id = ${m.documentId} and line_no = ${m.lineNo}
                   and cost is distinct from ${layerValue.toString()}::numeric`;
              repriced.push(m.id);
            }
          }
          const unitCost = layerValue.divide(magnitude.toDecimal(), "HALF_AWAY_FROM_ZERO");
          await tx`
            update app.cost_layer
               set value = ${layerValue.toString()}, unit_cost = ${unitCost.toString()}, qty_in = ${magnitude.toString()},
                   qty_remaining = ${magnitude.toString()}, invalidated_at = null
             where id = ${m.layerId}`;
          // Belt and braces for F4: the load above keeps every layer at or after the cursor out of `open`
          // until its own receipt is reached, so this receipt's layer cannot already be in it — but a layer
          // pushed twice averages every earlier-dated issue over stock dated after it, so it is taken out
          // before it is put back rather than trusted.
          const already = open.findIndex((l) => l.id === m.layerId);
          if (already >= 0) open.splice(already, 1);
          open.push({
            id: m.layerId,
            itemId: m.itemId,
            warehouseId: m.warehouseId,
            lotId: m.lotId,
            movementId: m.id,
            qtyIn: magnitude,
            value: layerValue,
            unitCost,
            qtyRemaining: magnitude,
            effectiveDate: m.effectiveDate,
            postingSeq: BigInt(m.postingSeq),
            lineNo: m.lineNo,
            movementNo: m.movementNo,
          });
          finalRemaining.set(m.layerId, magnitude);
          replayed += 1;
          continue;
        }

        // An issue: recompute the consumption set. `allowShortfall` is true here and only here — the
        // movement is already posted and its override, if any, was authorised at post time; refusing now
        // would abort a correction over a historical excursion, which is LEGACY-054 exactly.
        const cancellation = await purchaseCancellation(tx, {
          companyId,
          documentId: m.documentId,
          lineNo: m.lineNo,
          itemId: m.itemId,
          warehouseId: m.warehouseId,
          lotId: m.lotId,
          quantity: magnitude,
          baseCurrency,
        });
        let out;
        try {
          out = costingEngine.cost({
            method,
            ...(cancellation ? { cancellation } : {}),
            openLayers: open,
            allowShortfall: true,
            movement: {
              lineNo: m.lineNo,
              movementNo: m.movementNo,
              itemId: m.itemId,
              warehouseId: m.warehouseId,
              lotId: m.lotId,
              quantity: magnitude,
              effect: "issue",
              value,
              costing: "consume_layers",
              effectiveDate: m.effectiveDate,
              postingSeq: BigInt(m.postingSeq),
              movementId: m.id,
            },
          });
        } catch (error) {
          if (error instanceof CostingError) {
            throw new PostingError(error.code, `replay of movement ${m.id}: ${error.detail}`);
          }
          throw error;
        }

        for (const consumption of out.consumptions) {
          await tx`
            insert into app.cost_consumption (tenant_id, company_id, movement_id, layer_id, quantity, unit_cost, value)
            values (${ctx.tenantId}, ${companyId}, ${m.id}, ${consumption.layerId},
                    ${consumption.quantity.toString()}, ${consumption.unitCost.toString()},
                    ${consumption.value.toString()})`;
        }
        const remaining = new Map(out.updatedRemaining.map((u) => [u.layerId, u.qtyRemaining]));
        layerState.set(
          key,
          open
            .map((l) => {
              const after = remaining.get(l.id);
              return after === undefined ? l : { ...l, qtyRemaining: after };
            })
            .filter((l) => !l.qtyRemaining.isZero()),
        );
        for (const u of out.updatedRemaining) finalRemaining.set(u.layerId, u.qtyRemaining);

        // ADR 0038 note 2: document_line.cost is the CURRENT answer and is rewritten.
        await tx`
          update app.document_line set cost = ${out.value.toString()}
           where document_id = ${m.documentId} and line_no = ${m.lineNo}`;
        recostedIssues.set(m.id, out.value);
        replayed += 1;
      }

      for (const [layerId, qty] of finalRemaining) {
        await tx`update app.cost_layer set qty_remaining = ${qty.toString()} where id = ${layerId}`;
      }
      // Every issue this batch recomputed now waits to be booked, in the transaction that wrote its new
      // generation (0115). Step 4 books only these rows, so a crash before it — or a period that is closed
      // when it runs — leaves them for the next run to book rather than for nobody (C1). A reversal receipt
      // re-priced from its issue is booked the same way (INV-02): its row's `booked_value` is what the ledger
      // carries for the receipt, and `book` takes its difference with the opposite sign.
      const recomputed = [
        ...rows.filter((m) => m.quantity.startsWith("-")).map((m) => m.id),
        ...repriced,
      ];
      if (recomputed.length > 0) {
        await tx`
          insert into app.cost_booking as b (tenant_id, company_id, movement_id, booked_value, pending)
          select m.tenant_id, m.company_id, m.id, abs(m.value), 'booking'
            from app.inventory_movement m
           where m.company_id = ${companyId} and m.id = any(${recomputed}::uuid[])
          on conflict (tenant_id, movement_id) do update set pending = 'booking', updated_at = now()`;
      }
      const last = rows.at(-1)!;
      const next: Key = {
        effectiveDate: last.effectiveDate,
        postingSeq: BigInt(last.postingSeq),
        lineNo: last.lineNo,
        movementNo: last.movementNo + 1,
      };
      const full = rows.length === MOVEMENTS_PER_BATCH;
      if (full) {
        // Where a rerun must start if this run dies before the next batch commits. Each of this batch's
        // pairs keeps a mark at its first movement after the batch: a receipt step 2 saw has an invalid layer
        // already, and an issue is marked here. Without it, an issue posted while the run was under way that
        // no valid layer covered — so it has no consumption row to be found by, and step 2 never saw it —
        // sits just past the last movement this run replayed with nothing left in front of it, and the rerun
        // starts after it or not at all. A receipt posted while the run was under way needs no mark: its layer
        // is valid at its own place, and every issue after it either consumed it (so this batch re-invalidated
        // and marked that issue, above) or posts after this commit — behind whatever mark the pair still
        // carries, or, when it carries none, against a pair replayed up to it, which is date order at its own
        // post. One indexed lookup per pair.
        await tx`
          insert into app.cost_booking as b (tenant_id, company_id, movement_id, booked_value, pending)
          select n.tenant_id, n.company_id, n.id, abs(n.value), 'recost'
            from unnest(${pairItems}::uuid[], ${pairWarehouses}::uuid[]) as p(item_id, warehouse_id)
            cross join lateral (
              select m.tenant_id, m.company_id, m.id, m.value, m.quantity
                from app.inventory_movement m
               where m.company_id = ${companyId} and m.item_id = p.item_id and m.warehouse_id = p.warehouse_id
                 and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
                     >= (${next.effectiveDate}::date, ${next.postingSeq.toString()}::bigint, ${next.lineNo}::int, ${next.movementNo}::int)
               order by m.effective_date, m.posting_seq, m.line_no, m.movement_no
               limit 1) n
           where n.quantity < 0
          on conflict (tenant_id, movement_id) do update
             set pending = 'recost', updated_at = now()
           where b.pending is distinct from 'recost'`;
      }
      return { replayed, next, full };
    });
    if (batch === null) break;
    movementsReplayed += batch.replayed;
    cursor = batch.next;
    // A short batch is the end of the window. Its rows were read under the lock of every pair they touch, so
    // no movement of those pairs can lie beyond them; a post on a pair this batch did not touch found that
    // pair fully replayed and was costed in date order at its own post.
    if (!batch.full) break;
  }
  return movementsReplayed;
}

/** The forward pass's batch read, from `cursor` on the full chronological key. */
async function readBatch(
  tx: Sql,
  companyId: string,
  itemIds: string[],
  cursor: Key,
): Promise<MovementRow[]> {
  return tx<MovementRow[]>`
    select m.id::text as "id", m.document_id::text as "documentId", m.item_id::text as "itemId",
           m.warehouse_id::text as "warehouseId", m.lot_id::text as "lotId",
           m.line_no as "lineNo", m.movement_no as "movementNo",
           m.quantity::text as "quantity", m.value::text as "value",
           m.effective_date::text as "effectiveDate", m.posting_seq::text as "postingSeq",
           l.id::text as "layerId", l.qty_in::text as "layerQtyIn",
           src.id::text as "mirrorOf", src.cost::text as "mirrorCost", src.quantity::text as "mirrorQuantity"
      from app.inventory_movement m
      left join app.cost_layer l on l.tenant_id = m.tenant_id and l.movement_id = m.id
      -- INV-02 (ADR 0038's 2026-11-15 amendment): the issue a reversal's one-leg receipt mirrors — the
      -- movement of the reversed document on the same line, item, warehouse and lot. Exactly the receipts
      -- §4.7.2 branch 1 prices from a copied cost: a line with its own issue leg (a transfer, a transfer
      -- receipt, or the reversal of either) is branch 2's, and a counted line is branch 2b's.
      left join lateral (
        select om.id, ol.cost, abs(om.quantity) as quantity
          from app.document d
          join app.document_line ml on ml.tenant_id = m.tenant_id and ml.document_id = m.document_id and ml.line_no = m.line_no
          join app.inventory_movement om on om.tenant_id = d.tenant_id and om.document_id = d.reverses_document_id
                                        and om.line_no = m.line_no and om.item_id = m.item_id
                                        and om.warehouse_id = m.warehouse_id and om.lot_id = m.lot_id and om.quantity < 0
          join app.document_line ol on ol.tenant_id = om.tenant_id and ol.document_id = om.document_id and ol.line_no = om.line_no
         where d.tenant_id = m.tenant_id and d.id = m.document_id
           and m.quantity > 0 and ml.cost is not null
           and ml.expected_quantity is null and ml.counted_quantity is null
           and not exists (select 1 from app.inventory_movement leg
                            where leg.tenant_id = m.tenant_id and leg.document_id = m.document_id
                              and leg.line_no = m.line_no and leg.quantity < 0)
         limit 1) src on true
     where m.company_id = ${companyId}
       and m.item_id = any(${itemIds}::uuid[])
       and (m.effective_date, m.posting_seq, m.line_no, m.movement_no)
           >= (${cursor.effectiveDate}::date, ${cursor.postingSeq.toString()}::bigint, ${cursor.lineNo}::int, ${cursor.movementNo}::int)
     order by m.effective_date, m.posting_seq, m.line_no, m.movement_no
     limit ${MOVEMENTS_PER_BATCH}`;
}

/**
 * Step 4: the adjustment, one per (fiscal period, branch) whose COGS moved (ADR 0038 notes 5, 6), for every
 * issue movement waiting to be booked — this run's, and any an earlier run recomputed and could not book —
 * and for every reversal receipt re-priced from its issue (INV-02), whose layer's change counts negated.
 *
 * A movement's delta is what its current generation of consumptions COSTS minus what the ledger carries for
 * it: `cost_booking.booked_value`, its immutable `inventory_movement.value` until a replay books a difference
 * and that replay's "after" from then on (0115). That is decision 5's "the previous generation" held as a
 * figure rather than re-derived from rows, which could not work: `max(invalidated_at)` over consumption rows
 * cannot see a generation that has no row (an issue no layer covered writes none — 0034's `quantity > 0` and
 * NOT NULL `layer_id`), so the next run compared against the generation BEFORE it and booked the same
 * reversal again, on every run (C2). The figures are unchanged: `booked_value` starts at what the posting
 * booked, which is the engine's own value of the post-time generation, and each booking stores exactly the
 * "after" it posted against.
 *
 * What a generation cost is NOT Σ its consumption values when it fell short. An authorised shortfall is
 * valued at the running average and produces no `cost_consumption` row (ADR 0038 note 7), so the ledger
 * carries covered value + shortfall value — 600 + 25 for 125 issued against 120 @ 5 — while the rows hold
 * only the 600. `shortfall` below restates the engine's rule (engine.ts, `costIssue`): a short issue consumes
 * every open layer whole, so the uncovered quantity `need − covered` is valued at the average of exactly the
 * layers the rows consumed — under AVCO the `unit_cost` every row of the generation carries, under FIFO
 * Σ value ÷ Σ quantity — rounded HALF_AWAY_FROM_ZERO to 4 dp, which is Postgres's `round`. A generation with
 * no row at all is an issue no open layer covered, valued at the average of no layers: zero.
 *
 * Each group books in its own transaction and settles its rows there: the COST_ADJUSTMENT, the new
 * `booked_value` and the cleared `pending` commit together or not at all. A group whose sum is zero settles
 * without a document; a group with no open period records the incident and stays pending for the run after
 * an operator reopens one (decision 6's instruction, which the incident's summary repeats).
 */
async function book(
  run: Run,
  accounts: Awaited<ReturnType<typeof resolveAdjustmentAccounts>>,
  movementsReplayed: number,
): Promise<string[]> {
  const { sql, ctx, companyId, baseCurrency, method } = run;
  const groups = await withTenant(
    sql,
    ctx,
    // Groups in period order, then branch — an ordering of (period, branch) pairs, not of movements, so it
    // names the period's start rather than any part of the chronological key (LEGACY-010's check).
    (tx) => tx<{ fiscal_period_id: string; branch_id: string }[]>`
      select d.fiscal_period_id::text as fiscal_period_id, w.branch_id::text as branch_id
        from app.cost_booking b
        join app.inventory_movement m on m.tenant_id = b.tenant_id and m.id = b.movement_id
        join app.document      d on d.tenant_id = m.tenant_id and d.id = m.document_id
        join app.warehouse     w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
        join app.fiscal_period p on p.tenant_id = d.tenant_id and p.id = d.fiscal_period_id
       where b.company_id = ${companyId} and b.pending = 'booking'
       group by d.fiscal_period_id, w.branch_id, p.starts_on
       order by p.starts_on, w.branch_id`,
  );

  const adjustmentsPosted: string[] = [];
  for (const group of groups) {
    const posted = await withTenant(sql, ctx, async (tx) => {
      // The audit lock, then the group's rows, locked and re-read under the lock. In that order (see `replay`'s
      // lock-order note): the COST_ADJUSTMENT insert below takes the audit lock anyway, and a back-dated post
      // holds it while `invalidateFrom` waits for one of these rows. So a back-dated post that re-marks one of
      // them `'recost'` either committed first (the row drops out here and waits for the replay that post
      // enqueued) or waits, before it holds any row, for this transaction, whose consumption reads cannot see
      // its invalidation.
      await lockTenantAuditSerial(tx, ctx.tenantId);
      const pending = await tx<{ id: string; source: string }[]>`
        select b.id::text as id, d.effective_date::text as source
          from app.cost_booking b
          join app.inventory_movement m on m.tenant_id = b.tenant_id and m.id = b.movement_id
          join app.document  d on d.tenant_id = m.tenant_id and d.id = m.document_id
          join app.warehouse w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
         where b.company_id = ${companyId} and b.pending = 'booking'
           and d.fiscal_period_id = ${group.fiscal_period_id} and w.branch_id = ${group.branch_id}
         order by b.id
           for update of b`;
      if (pending.length === 0) return null;
      const ids = pending.map((p) => p.id);
      // A receipt's row is a reversal receipt re-priced from its issue (INV-02): what it costs now is its
      // layer's value, and a rise in it is a fall in COGS — the mirror of its issue's difference — so its
      // difference enters the group's sum negated.
      const valued = await tx<
        { id: string; after_value: string; before_value: string; receipt: boolean }[]
      >`
        with scope as (
          select b.id, m.tenant_id, m.id as movement_id, abs(m.quantity) as need, b.booked_value,
                 m.quantity > 0 as receipt
            from app.cost_booking b
            join app.inventory_movement m on m.tenant_id = b.tenant_id and m.id = b.movement_id
           where b.company_id = ${companyId} and b.id = any(${ids}::uuid[])
        ),
        generation as (
          select s.id, s.need,
                 sum(c.value) as consumed, sum(c.quantity) as covered, max(c.unit_cost) as unit_cost
            from scope s
            join app.cost_consumption c on c.tenant_id = s.tenant_id and c.movement_id = s.movement_id
           where c.invalidated_at is null
           group by s.id, s.need
        ),
        valued as (
          select g.id,
                 g.consumed + case when g.covered < g.need
                                   then round(case when ${method} = 'avco' then g.unit_cost
                                                   else round(g.consumed / g.covered, 4) end
                                              * (g.need - g.covered), 4)
                                   else 0 end as cost
            from generation g
        )
        select s.id::text as id,
               (case when s.receipt
                     then (select l.value from app.cost_layer l
                            where l.tenant_id = s.tenant_id and l.movement_id = s.movement_id)
                     else coalesce(v.cost, 0) end)::numeric(19,4)::text as after_value,
               s.booked_value::text as before_value, s.receipt
          from scope s left join valued v on v.id = s.id`;
      // `Money`, never a JS number: the signed sum of the group's differences, then its direction.
      const delta = valued.reduce((sum, r) => {
        const moved = Money.of(r.after_value, baseCurrency).subtract(
          Money.of(r.before_value, baseCurrency),
        );
        return r.receipt ? sum.subtract(moved) : sum.add(moved);
      }, Money.zero(baseCurrency));
      // `row.source` is the earliest REPLAYED document date in this (period, branch) group — the point the
      // recomputation ran forward from — not necessarily the back-dated document itself. ISO dates, so the
      // string order is the date order.
      const source = pending.map((p) => p.source).toSorted()[0]!;

      let documentId: string | null = null;
      if (!delta.isZero()) {
        documentId = await postAdjustment(tx, run, accounts, {
          fiscalPeriodId: group.fiscal_period_id,
          branchId: group.branch_id,
          source,
          delta,
          movementsReplayed,
        });
        // No open period: the incident is recorded and the rows stay `'booking'` for the next run.
        if (documentId === null) return null;
      }
      await tx`
        update app.cost_booking b
           set booked_value = v.after_value, pending = null, booked_at = now(), updated_at = now()
          from (select unnest(${valued.map((r) => r.id)}::uuid[]) as id,
                       unnest(${valued.map((r) => r.after_value)}::numeric[]) as after_value) v
         where b.id = v.id`;
      return documentId;
    });
    if (posted) adjustmentsPosted.push(posted);
  }
  return adjustmentsPosted;
}

/** One group's COST_ADJUSTMENT, or null when there is no open period to post it into (decision 6). */
async function postAdjustment(
  tx: Sql,
  run: Run,
  accounts: Awaited<ReturnType<typeof resolveAdjustmentAccounts>>,
  row: {
    fiscalPeriodId: string;
    branchId: string;
    source: string;
    delta: Money;
    movementsReplayed: number;
  },
): Promise<string | null> {
  const { ctx, companyId, baseCurrency } = run;
  const [target] = await tx<{ id: string; starts_on: string; ends_on: string; same: boolean }[]>`
    select p.id::text as id, p.starts_on::text as starts_on, p.ends_on::text as ends_on,
           (p.id = ${row.fiscalPeriodId}) as same
      from app.fiscal_period p
     where p.company_id = ${companyId} and p.status = 'open'
       and p.starts_on >= (select starts_on from app.fiscal_period where id = ${row.fiscalPeriodId})
     order by p.starts_on limit 1`;
  if (!target) {
    // ADR 0038 note 6: no open period on or after the affected one. The layers are already right; the
    // ledger is not, and a human has to reopen a period. Record it and stop — never retry forever. The
    // group's booking rows stay pending, so the replay run after a reopen posts exactly this figure.
    //
    // 1B's signature is `recordIntegrityIncident(tx, report: IntegrityReport)`; the argument is a whole
    // report, not a loose `{ companyId, detail }`. This run checked no projection and walked no chain,
    // so every other member is its empty value and `summary` carries the sentence an operator reads.
    await recordIntegrityIncident(tx, {
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
      checkedAt: new Date().toISOString(),
      ledgerBalance: { byPeriod: [], byDocument: [] },
      projections: { checked: [], mismatches: [] },
      auditChain: { rows: 0, brokenLinks: 0, badHashes: 0, firstBrokenSeq: null },
      periodReopens: [],
      ok: false,
      summary: `FAILED: cost replay of company ${companyId} recomputed ${row.movementsReplayed} movement(s) but found no open fiscal period on or after ${row.source} to post the ${row.delta.toString()} adjustment into; reopen a period under accounting.period.reopen and re-enqueue inventory.cost.replay`,
    });
    return null;
  }
  const notes = adjustmentNotes(row.source, target.same);
  const [doc] = await tx<{ id: string }[]>`
    insert into app.document (tenant_id, company_id, document_type_id, series, effective_date, currency, branch_id, notes)
    values (${ctx.tenantId}, ${companyId}, ${accounts.documentTypeId}, 'CA',
            ${target.same ? row.source : target.starts_on}, ${baseCurrency}, ${row.branchId}, ${notes})
    returning id::text as id`;
  if (!doc) {
    throw new PostingError(
      "ERR_INTERNAL",
      `replay: the ${COST_ADJUSTMENT_CODE} header for company ${companyId} was written but returned no id`,
    );
  }
  // `Money.of` accepts the signed string; the sign then moves into WHICH account gets the debit, which is
  // amendment A9's discipline — read the direction, never `amount.isNegative()` at the point of writing.
  // Amendment A12: the JOB supplies the direction, because document_line.debit has check (debit >= 0).
  const rose = !row.delta.isNegative();
  const amount = row.delta.abs().toString();
  await tx`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit, description)
    values (${ctx.tenantId}, ${companyId}, ${doc.id}, 1, 'account',
            ${rose ? accounts.cogsAccountId : accounts.inventoryAccountId}, ${amount}, '0.0000',
            ${rose ? "Recomputed cost of goods sold" : "Recomputed inventory value"})`;
  await tx`
    insert into app.document_line (tenant_id, company_id, document_id, line_no, kind, account_id, debit, credit, description)
    values (${ctx.tenantId}, ${companyId}, ${doc.id}, 2, 'account',
            ${rose ? accounts.inventoryAccountId : accounts.cogsAccountId}, '0.0000', ${amount},
            ${rose ? "Recomputed inventory value" : "Recomputed cost of goods sold"})`;
  // `inventory.effect: "none"` (Task 8), so step 14 never consults `jobs` and none is passed.
  await postDocument(tx, ctx, { documentId: doc.id });
  return doc.id;
}
