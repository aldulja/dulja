import type { Sql } from "postgres";

/**
 * The default reporting horizon for the near-expiry alert. **A reporting choice, not a statutory figure** —
 * hazard 1 does not engage: nothing about it is a rate, threshold, ceiling or formula from any authority. A
 * tenant that wants a different window passes `horizonDays` in the job payload.
 */
export const EXPIRY_HORIZON_DAYS = 30;

export interface NearExpiryLot {
  companyId: string;
  itemId: string;
  itemCode: string;
  lotId: string;
  lotCode: string;
  expiresOn: string;
  warehouseId: string;
  warehouseCode: string;
  quantity: string;
  daysToExpiry: number;
}

/**
 * Lots with stock on hand that expire on or before `asOf + horizonDays`, soonest first. Reads the synchronous
 * projection, so a lot whose stock has all been issued does not appear — the alert is about goods that are
 * still there. A lot with no `expires_on` — every item's `NONE` sentinel, and any untracked batch — is never
 * reported: it has no expiry to warn about.
 */
export async function listNearExpiryLots(
  tx: Sql,
  params: { companyId?: string; horizonDays?: number; asOf?: string },
): Promise<NearExpiryLot[]> {
  return tx<NearExpiryLot[]>`
    select h.company_id            as "companyId",
           h.item_id               as "itemId",
           i.code                  as "itemCode",
           h.lot_id                as "lotId",
           l.code                  as "lotCode",
           l.expires_on::text      as "expiresOn",
           h.warehouse_id          as "warehouseId",
           w.code                  as "warehouseCode",
           h.quantity::text        as "quantity",
           (l.expires_on - coalesce(${params.asOf ?? null}::date, current_date))::int as "daysToExpiry"
      from app.stock_on_hand h
      join app.lot l       on l.tenant_id = h.tenant_id and l.id = h.lot_id
      join app.item i      on i.tenant_id = h.tenant_id and i.id = h.item_id
      join app.warehouse w on w.tenant_id = h.tenant_id and w.id = h.warehouse_id
     where h.quantity > 0
       and l.expires_on is not null
       and l.archived_at is null
       and (${params.companyId ?? null}::uuid is null or h.company_id = ${params.companyId ?? null})
       and l.expires_on <= coalesce(${params.asOf ?? null}::date, current_date)
                           + ${params.horizonDays ?? EXPIRY_HORIZON_DAYS}::int
     order by l.expires_on, i.code, l.code, w.code`;
}

/**
 * One `app.audit_log` row per company per run, under the sentinel `table_name` **`lot_expiry_warning`** —
 * the third allocated sentinel after 1B's `integrity_incident` and `month_end_ready` (§4.2.6). The alert has
 * no row of its own: `needs_attention` is 6A's table and this slice does not anticipate it.
 *
 * Called only when there is something to report, so a quiet company writes nothing and the log stays readable.
 */
export async function recordExpiryWarning(
  tx: Sql,
  input: { companyId: string; lots: readonly NearExpiryLot[] },
): Promise<void> {
  if (input.lots.length === 0) return;
  // NOT the plan page's `insert into app.audit_log (...)`. Migration 0001 §8 REVOKES insert on
  // `app.audit_log` from `app_rw` (0001:543) and the Phase 2 review pass (ADR 0087, migration 0105)
  // replaced 1B's direct inserts with this narrow SECURITY DEFINER door, which takes the tenant from the
  // session and never from a parameter. `recordIntegrityIncident` as it NOW stands is one call to it, and
  // the plan's own Step 4 says to follow that function rather than the page. The `seq`, `actor_id` and
  // `occurred_at` columns come from defaults and the `audit_chain` trigger, exactly as before.
  //
  // `lot_expiry_warning` is the THIRD sentinel; 0105's closed list admits only the first two, so this call
  // raises `ERR_VALIDATION_FAILED` until a migration adds the name. That migration is owed and is not in
  // this task's file list — 3A's 0028-0033 range is spent, so it is an amendment, not a plan edit.
  await tx`
    select app.record_system_event('lot_expiry_warning', ${input.companyId},
            ${JSON.stringify({
              companyId: input.companyId,
              lotCount: input.lots.length,
              soonest: input.lots[0]!.expiresOn,
              lots: input.lots.map((l) => ({
                itemCode: l.itemCode,
                lotCode: l.lotCode,
                warehouseCode: l.warehouseCode,
                expiresOn: l.expiresOn,
                quantity: l.quantity,
              })),
            })}::text::jsonb)`;
}
