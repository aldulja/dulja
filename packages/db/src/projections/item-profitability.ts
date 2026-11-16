// packages/db/src/projections/item-profitability.ts
//
// Slice 4B. The third asynchronous projection of spec:1204. It is 4B's and not 3B's because REVENUE does not
// exist before 4A: 3D shipped inventory.sales_by_item on delivered quantity and cost, 4A extended that same
// code with revenue and margin, and 7B re-expresses the code over this table.
//
// Every figure comes out of app.item_profitability_rows (migration 0048). This module selects, MERGEs and
// compares; it contains no attribution arithmetic of its own (ADR 0046). It is deliberately NOT on the
// posting-only-tables lint's list (contracts §3.7.5 excludes the three async projections by name): the
// accounting.projection.rebuild job is its only writer.
import type { Sql } from "postgres";
import type { ProjectionCheck, ProjectionMismatch } from "../integrity/types";

/**
 * Document types that are SALE documents (contracts §4.6.1, amendment 6). MEMBERSHIP ONLY — it carries no
 * sign: the direction of revenue is read from the ledger per document, and the direction of quantity and
 * cost from the movement's own sign (amendment 7).
 *
 * Membership means "a sale document", not "a document with a movement": under 4A's ADR 0044 SALES_INVOICE
 * and SALES_CREDIT_NOTE are financial-only in every case, so two of the three members carry no movement,
 * while the DELIVERY_ORDER carries the movement and no revenue. Since code review B4 membership selects the
 * MOVEMENTS only: revenue is `app.item_revenue_rows` (0048), read off the pinned policy's
 * `item.revenue_account` rules and no list, the one definition `inventory.sales_by_item` reads too.
 *
 * **6A appends "POS_TICKET" in the PR that seeds that type.** The exhaustiveness test in
 * `packages/db/test/ar-ap/item-profitability.test.ts` is what makes that an obligation rather than a hope.
 */
export const SALE_MOVEMENT_TYPES: readonly string[] = [
  "DELIVERY_ORDER", // 3D — the stock issue; posts to 1250, never to a revenue account
  "SALES_INVOICE", // 4A — revenue; never a movement (ADR 0044)
  "SALES_CREDIT_NOTE", // 4A — negative revenue; never a movement (ADR 0044)
  "POS_TICKET", // 6A — sale issues and return receipts, with revenue through the existing policy
];

/**
 * Every other SHIPPED type with a stock effect, so the exhaustiveness test can name a type that is in neither
 * list and fail, forcing the slice that adds it to classify it. A type is added here when its movements are
 * NOT sales: a purchase, a purchase return, a transfer, a count variance, a write-off — and 9B's
 * OPENING_STOCK in the PR that ships it. A financial-only type (effect "none" — PURCHASE_INVOICE and
 * PURCHASE_CREDIT_NOTE under ADR 0044) is in neither list, because it has no movement to classify.
 */
export const NON_SALE_MOVEMENT_TYPES: readonly string[] = [
  "SHIPMENT", // 3C
  "GOODS_RECEIPT", // 3C
  "PURCHASE_RETURN", // 3C
  "TRANSFER", // 3D
  "TRANSFER_RECEIPT", // 3D
  "STOCK_COUNT", // 3D
  "EXPIRY_WRITE_OFF", // 3D
  "OPENING_STOCK", // 9B — the cut-over's opening receipts; never a sale
];

export interface ItemProfitabilityRow {
  itemId: string;
  fiscalPeriodId: string;
  /** 6 dp, base unit. An issue adds, a return subtracts. */
  quantitySold: string;
  /** 4 dp, base currency. */
  revenueBase: string;
  cogsBase: string;
  /** `revenueBase − cogsBase`, stored so a reader never recomputes it. */
  marginBase: string;
}

/** The membership as a fresh mutable array — the shape postgres.js binds as a `text[]` parameter. */
const saleTypes = (): string[] => [...SALE_MOVEMENT_TYPES];

/** The fresh figures for one company, read straight off the one definition (never off the stored table). */
export async function itemProfitabilityRows(
  tx: Sql,
  params: { companyId: string },
): Promise<ItemProfitabilityRow[]> {
  const rows = await tx<
    {
      item_id: string;
      fiscal_period_id: string;
      quantity_sold: string;
      revenue_base: string;
      cogs_base: string;
      margin_base: string;
    }[]
  >`
    select item_id::text as item_id, fiscal_period_id::text as fiscal_period_id,
           quantity_sold::text as quantity_sold, revenue_base::text as revenue_base,
           cogs_base::text as cogs_base, margin_base::text as margin_base
      from app.item_profitability_rows(${params.companyId}::uuid, ${saleTypes()}::text[])
     order by item_id, fiscal_period_id`;
  return rows.map((r) => ({
    itemId: r.item_id,
    fiscalPeriodId: r.fiscal_period_id,
    quantitySold: r.quantity_sold,
    revenueBase: r.revenue_base,
    cogsBase: r.cogs_base,
    marginBase: r.margin_base,
  }));
}

/**
 * MERGE the fresh rows into the table for this company, then zero the keys the fresh set no longer contains.
 * It NEVER deletes: §3.5.4's app_rw DELETE list is pinned to five tables and 2B is its only extender
 * (ADR 0046). A zeroed row and an absent row read identically to every reader, and `zeroed` counts only keys
 * that were non-zero before this run.
 *
 * ONE statement and ONE evaluation of `app.item_profitability_rows` (code review B3): a `materialized` CTE of
 * the fresh rows feeds both data-modifying CTEs, the MERGE and the zeroing UPDATE, which touch disjoint keys.
 * Every sub-statement reads one snapshot, so the zeroing never sees a key the MERGE inserts.
 *
 * SERIALISED per company first (code review 2, F6), as contracts amendment A4 serialises account_balance's
 * MERGE: two overlapping rebuilds — the nightly `.fanout`'s `runJob` and a post-triggered job — both took
 * `WHEN NOT MATCHED` for a key neither had written and the second raised 23505 at the first's commit. The
 * table's key carries no as_of, so the lock is the company's. It is its OWN statement, before the MERGE's, so
 * the MERGE's READ COMMITTED snapshot is taken after it is granted and sees the other run's rows (see
 * `rebuildPartyAgeing`, whose lock the job takes first).
 */
export async function rebuildItemProfitability(
  tx: Sql,
  params: { companyId: string },
): Promise<{ merged: number; zeroed: number }> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`item_profitability:${params.companyId}`}, 0))`;
  const [counts] = await tx<{ merged: number; zeroed: number }[]>`
    with fresh as materialized (
      select r.item_id, r.fiscal_period_id, r.quantity_sold, r.revenue_base, r.cogs_base, r.margin_base
        from app.item_profitability_rows(${params.companyId}::uuid, ${saleTypes()}::text[]) r
    ),
    merged as (
      merge into app.item_profitability t
      using fresh s
         on t.company_id = ${params.companyId}::uuid and t.item_id = s.item_id
        and t.fiscal_period_id = s.fiscal_period_id
       when matched then update
            set quantity_sold = s.quantity_sold, revenue_base = s.revenue_base,
                cogs_base = s.cogs_base, margin_base = s.margin_base, updated_at = now()
       when not matched then insert
            (tenant_id, company_id, item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base)
            values (app.current_tenant(), ${params.companyId}::uuid, s.item_id, s.fiscal_period_id,
                    s.quantity_sold, s.revenue_base, s.cogs_base, s.margin_base)
      returning 1
    ),
    zeroed as (
      update app.item_profitability t
         set quantity_sold = 0, revenue_base = 0, cogs_base = 0, margin_base = 0, updated_at = now()
       where t.company_id = ${params.companyId}::uuid
         and (t.quantity_sold <> 0 or t.revenue_base <> 0 or t.cogs_base <> 0 or t.margin_base <> 0)
         and not exists (
           select 1 from fresh r
            where r.item_id = t.item_id and r.fiscal_period_id = t.fiscal_period_id)
      returning 1
    )
    select (select count(*) from merged)::int as merged, (select count(*) from zeroed)::int as zeroed`;

  return { merged: counts!.merged, zeroed: counts!.zeroed };
}

/**
 * Rebuild-and-compare (test 2, spec:1204 "a mismatch is an incident") for every company RLS lets the caller
 * see, so it fits `ProjectionCheck.run(tx)`'s one-argument shape (§4.16.3); 1B's nightly
 * accounting.ledger.integrity_check is the caller. The stored table is full-outer-joined against the fresh
 * function per company. A zero stored row reads as absent, and a missing side is reported as missing rather
 * than compared as zero.
 */
export async function compareItemProfitability(tx: Sql): Promise<ProjectionMismatch[]> {
  const companies = await tx<{ id: string }[]>`select id::text as id from app.company order by id`;
  const mismatches: ProjectionMismatch[] = [];

  for (const { id: companyId } of companies) {
    const rows = await tx<
      {
        item_id: string;
        fiscal_period_id: string;
        s_qty: string | null;
        s_rev: string | null;
        s_cogs: string | null;
        s_margin: string | null;
        f_qty: string | null;
        f_rev: string | null;
        f_cogs: string | null;
        f_margin: string | null;
      }[]
    >`
      with stored as (
        select item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base
          from app.item_profitability
         where company_id = ${companyId}::uuid
           and (quantity_sold <> 0 or revenue_base <> 0 or cogs_base <> 0 or margin_base <> 0)
      ),
      fresh as (
        select item_id, fiscal_period_id, quantity_sold, revenue_base, cogs_base, margin_base
          from app.item_profitability_rows(${companyId}::uuid, ${saleTypes()}::text[])
      )
      select coalesce(s.item_id, f.item_id)::text                   as item_id,
             coalesce(s.fiscal_period_id, f.fiscal_period_id)::text as fiscal_period_id,
             s.quantity_sold::text as s_qty,  s.revenue_base::text as s_rev,
             s.cogs_base::text     as s_cogs, s.margin_base::text  as s_margin,
             f.quantity_sold::text as f_qty,  f.revenue_base::text as f_rev,
             f.cogs_base::text     as f_cogs, f.margin_base::text  as f_margin
        from stored s
        full outer join fresh f
          on f.item_id = s.item_id and f.fiscal_period_id = s.fiscal_period_id
       where s.item_id is null or f.item_id is null
          or s.quantity_sold <> f.quantity_sold or s.revenue_base <> f.revenue_base
          or s.cogs_base     <> f.cogs_base     or s.margin_base  <> f.margin_base
       order by 1, 2`;

    for (const r of rows) {
      const key = {
        company_id: companyId,
        item_id: r.item_id,
        fiscal_period_id: r.fiscal_period_id,
      };
      if (r.s_qty === null) {
        mismatches.push({
          projection: "item_profitability",
          key,
          side: "missing_in_projection",
          detail: `fresh quantity_sold ${r.f_qty}, revenue_base ${r.f_rev}, cogs_base ${r.f_cogs}, margin_base ${r.f_margin}, no stored row`,
        });
        continue;
      }
      if (r.f_qty === null) {
        mismatches.push({
          projection: "item_profitability",
          key,
          side: "missing_in_rebuild",
          detail: `stored quantity_sold ${r.s_qty}, revenue_base ${r.s_rev}, cogs_base ${r.s_cogs}, margin_base ${r.s_margin}, no fresh row`,
        });
        continue;
      }
      const parts: string[] = [];
      if (r.s_qty !== r.f_qty) parts.push(`quantity_sold ${r.s_qty} <> ${r.f_qty}`);
      if (r.s_rev !== r.f_rev) parts.push(`revenue_base ${r.s_rev} <> ${r.f_rev}`);
      if (r.s_cogs !== r.f_cogs) parts.push(`cogs_base ${r.s_cogs} <> ${r.f_cogs}`);
      if (r.s_margin !== r.f_margin) parts.push(`margin_base ${r.s_margin} <> ${r.f_margin}`);
      mismatches.push({
        projection: "item_profitability",
        key,
        side: "amount_differs",
        detail: parts.join("; "),
      });
    }
  }
  return mismatches;
}

/** The ProjectionCheck this slice contributes to 1B's registry; registered in ../integrity/index.ts. */
export const ITEM_PROFITABILITY_CHECK: ProjectionCheck = {
  name: "item_profitability",
  run: compareItemProfitability,
};
