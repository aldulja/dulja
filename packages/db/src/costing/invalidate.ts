import type { Sql } from "postgres";
import type { JobClient } from "../jobs/enqueue";
import type { TenantContext } from "../with-tenant";

/**
 * The tenant's audit serialisation: `app.audit_chain`'s own advisory key (migration 0010, `'tenant-serial:' ||
 * tenant_id`, the same `hashtextextended(…, 0)`), taken by hand. Code review 3, R1.
 *
 * Every audited write takes this lock and holds it to commit, and a poster makes its first one — the draft's
 * header, or postDocument step 7 or 8's UPDATE of the document — before it takes any `stock:` key or locks any
 * cost row. So a transaction that locks a stock key or a `cost_layer`, `cost_consumption` or `cost_booking` row
 * FIRST and makes an audited write LATER holds the two in the opposite order to every poster, and deadlocks with
 * the first poster that needs one of its rows: the cost replay did exactly that in step 4 (its group's
 * booking rows, then the COST_ADJUSTMENT insert) and in every step-3 batch (stock keys and cost rows, then
 * `document_line.cost`). Such a transaction calls this before it takes its first lock — a plain read may come
 * first — so it waits for a poster holding no lock, or makes the poster wait for it before the poster holds one.
 *
 * Re-taking it is free: an advisory lock the transaction already holds is granted at once.
 *
 * The key goes through `uuid` and back, so it is the trigger's `new.tenant_id::text` — the column's canonical
 * spelling — whatever spelling of the same uuid the caller holds (braces, upper case, no hyphens). Built from
 * the caller's string, it would be another lock for any of those, and the order would silently not hold.
 */
export async function lockTenantAuditSerial(tx: Sql, tenantId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended('tenant-serial:' || ${tenantId}::uuid::text, 0))`;
}

/**
 * Marks every layer and consumption of the affected items at or after `(effectiveDate, postingSeq)` invalid
 * and enqueues ONE `inventory.cost.replay` per company (contracts §4.7.2). Runs on the caller's `tx`, so the
 * invalidation and the enqueue commit with the posting or roll back with it (spec:1127 — the guarantee
 * SAH-005 lacked, where a dirty flag was set from three of four code paths).
 *
 * The comparison is Postgres's row-wise `>=`, which is the contracts §4.3.5 key's first two elements compared
 * lexicographically — exactly "at or after its sequence" (spec:1220). Spelling it as
 * `effective_at > d or (effective_at = d and sequence >= s)` is the same thing written less safely.
 *
 * Note what is NOT invalidated: a layer *before* the point that a movement *after* the point consumed from.
 * Its consumption row IS invalidated (the movement is at or after), so the layer's `qty_remaining` is now
 * stale — and restoring it is `replay`'s first act, not this function's, because doing it here would leave a
 * window in which the layer over-reports availability to a concurrent poster.
 *
 * **Every ISSUE movement at or after the point is marked `pending = 'recost'` in `app.cost_booking`** (migration
 * 0115; code review 2, C1 and C2), in the same statement set as its consumptions are invalidated — the posting
 * document's own issues included. Two things depend on it. A back-dated issue that NO layer covered writes no
 * consumption row, so without its own mark nothing would place the replay's start at it and the replay would
 * begin at the next movement instead (C2's second case). And a replay already running when this commits must
 * not book a movement this post has just invalidated: its step 4 books only rows it moved to `'booking'`, and a
 * row this marks back to `'recost'` waits for the replay this call enqueues. A movement's first booking row
 * starts from its immutable `inventory_movement.value`, which is what its posting put on the ledger.
 */
export async function invalidateFrom(
  tx: Sql,
  ctx: TenantContext,
  input: {
    companyId: string;
    itemIds: string[];
    effectiveDate: string;
    postingSeq: bigint;
    jobs: JobClient;
  },
): Promise<void> {
  if (input.itemIds.length === 0) return;

  // The audit lock before the first cost row (code review 3, R1). postDocument's step 7 or 8 took it already,
  // so this re-entry is free there; it states the order the replay relies on for any caller that has not.
  await lockTenantAuditSerial(tx, ctx.tenantId);

  await tx`
    update app.cost_layer
       set invalidated_at = now()
     where company_id = ${input.companyId}
       and item_id = any(${input.itemIds}::uuid[])
       and (effective_at, sequence) >= (${input.effectiveDate}::date, ${input.postingSeq.toString()}::bigint)
       and invalidated_at is null`;

  await tx`
    update app.cost_consumption c
       set invalidated_at = now()
      from app.inventory_movement m
     where m.tenant_id = c.tenant_id and m.id = c.movement_id
       and m.company_id = ${input.companyId}
       and m.item_id = any(${input.itemIds}::uuid[])
       and (m.effective_date, m.posting_seq) >= (${input.effectiveDate}::date, ${input.postingSeq.toString()}::bigint)
       and c.invalidated_at is null`;

  await tx`
    insert into app.cost_booking as b (tenant_id, company_id, movement_id, booked_value, pending)
    select m.tenant_id, m.company_id, m.id, abs(m.value), 'recost'
      from app.inventory_movement m
     where m.company_id = ${input.companyId}
       and m.item_id = any(${input.itemIds}::uuid[])
       and (m.effective_date, m.posting_seq) >= (${input.effectiveDate}::date, ${input.postingSeq.toString()}::bigint)
       and m.quantity < 0
    on conflict (tenant_id, movement_id) do update
       set pending = 'recost', updated_at = now()
     where b.pending is distinct from 'recost'`;

  await input.jobs.enqueue(
    tx,
    "inventory.cost.replay",
    { tenantId: ctx.tenantId, requestId: ctx.requestId, payload: { companyId: input.companyId } },
    { singletonKey: input.companyId },
  );
}
