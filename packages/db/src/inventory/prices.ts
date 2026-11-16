import { Quantity } from "@dulja/domain";
import type { Sql } from "postgres";

export interface PriceListRow {
  id: string;
  companyId: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  currency: string;
  customerKind: string | null;
  branchId: string | null;
  validFrom: string | null;
  validTo: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface PriceListLineInput {
  itemId: string;
  unitId?: string | null;
  minQuantity?: string;
  unitPrice: string;
}

export interface PriceListLineRow {
  id: string;
  priceListId: string;
  itemId: string;
  unitId: string | null;
  minQuantity: string;
  unitPrice: string;
  archivedAt: string | null;
  createdAt: string;
}

// The column list is repeated at each site rather than held in a constant and spliced with `tx.unsafe`.
// That is not an oversight: hazard 21 gives the driver's `unsafe` helper exactly three homes — the
// migration runner, the pg-boss enqueue adapter and the Firebird reader — and `no-sql-concat` (§3.7.5)
// fails on an `unsafe(` call with a non-literal argument. postgres.js can splice an identifier list with
// `tx(cols)` but not one carrying `as "alias"` renames, so the honest form is the repeated literal.

export async function createPriceList(
  tx: Sql,
  input: {
    companyId: string;
    code: string;
    nameEn: string;
    nameAr?: string | null;
    currency: string;
    customerKind?: string | null;
    branchId?: string | null;
    validFrom?: string | null;
    validTo?: string | null;
  },
): Promise<PriceListRow> {
  const [row] = await tx<PriceListRow[]>`
    insert into app.price_list
      (tenant_id, company_id, code, name_en, name_ar, currency, customer_kind, branch_id, valid_from, valid_to)
    values (app.current_tenant(), ${input.companyId}, ${input.code}, ${input.nameEn}, ${input.nameAr ?? null},
            ${input.currency}, ${input.customerKind ?? null}, ${input.branchId ?? null},
            ${input.validFrom ?? null}, ${input.validTo ?? null})
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              currency, customer_kind as "customerKind", branch_id as "branchId",
              valid_from::text as "validFrom", valid_to::text as "validTo",
              archived_at::text as "archivedAt", created_at::text as "createdAt"`;
  return row!;
}

export async function updatePriceList(
  tx: Sql,
  priceListId: string,
  patch: {
    nameEn?: string;
    nameAr?: string | null;
    customerKind?: string | null;
    validFrom?: string | null;
    validTo?: string | null;
  },
): Promise<PriceListRow | null> {
  const [row] = await tx<PriceListRow[]>`
    update app.price_list set
      name_en       = coalesce(${patch.nameEn ?? null}, name_en),
      name_ar       = case when ${patch.nameAr !== undefined} then ${patch.nameAr ?? null} else name_ar end,
      customer_kind = case when ${patch.customerKind !== undefined} then ${patch.customerKind ?? null} else customer_kind end,
      valid_from    = case when ${patch.validFrom !== undefined} then ${patch.validFrom ?? null}::date else valid_from end,
      valid_to      = case when ${patch.validTo !== undefined} then ${patch.validTo ?? null}::date else valid_to end
    where id = ${priceListId}
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              currency, customer_kind as "customerKind", branch_id as "branchId",
              valid_from::text as "validFrom", valid_to::text as "validTo",
              archived_at::text as "archivedAt", created_at::text as "createdAt"`;
  return row ?? null;
}

export async function archivePriceList(tx: Sql, priceListId: string): Promise<PriceListRow | null> {
  const [row] = await tx<PriceListRow[]>`
    update app.price_list set archived_at = now()
     where id = ${priceListId} and archived_at is null
    returning id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
              currency, customer_kind as "customerKind", branch_id as "branchId",
              valid_from::text as "validFrom", valid_to::text as "validTo",
              archived_at::text as "archivedAt", created_at::text as "createdAt"`;
  return row ?? null;
}

export async function getPriceList(tx: Sql, priceListId: string): Promise<PriceListRow | null> {
  const [row] = await tx<PriceListRow[]>`
    select id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
           currency, customer_kind as "customerKind", branch_id as "branchId",
           valid_from::text as "validFrom", valid_to::text as "validTo",
           archived_at::text as "archivedAt", created_at::text as "createdAt"
      from app.price_list where id = ${priceListId}`;
  return row ?? null;
}

export async function listPriceLists(
  tx: Sql,
  params: {
    companyId: string;
    branchId?: string | null;
    includeArchived?: boolean;
    cursor?: { code: string } | null;
    limit: number;
  },
): Promise<PriceListRow[]> {
  return tx<PriceListRow[]>`
    select id, company_id as "companyId", code, name_en as "nameEn", name_ar as "nameAr",
           currency, customer_kind as "customerKind", branch_id as "branchId",
           valid_from::text as "validFrom", valid_to::text as "validTo",
           archived_at::text as "archivedAt", created_at::text as "createdAt"
      from app.price_list
     where company_id = ${params.companyId}
       and (${params.includeArchived ?? false} or archived_at is null)
       and (${params.branchId ?? null}::uuid is null or branch_id is null or branch_id = ${params.branchId ?? null})
       and (${params.cursor?.code ?? null}::text is null or code > ${params.cursor?.code ?? null})
     order by code
     limit ${params.limit}`;
}

// Both sides of the archive comparison must be the SAME TEXT for the same quantity, and `min_quantity::text`
// on a numeric(19,6) is always six decimal places. A key built from a raw "0" or "100" would match nothing,
// and every line would be archived on every call. `Quantity.of(...).toString()` is the one normaliser. It sits
// at module scope rather than inside `replacePriceListLines` because it captures nothing from that scope.
const normaliseBreak = (q: string | undefined): string => Quantity.of(q ?? "0.000000").toString();

/**
 * Upserts every supplied line and archives every non-archived line the payload omits — a replace performed
 * without a DELETE, because contracts §3.5.4 pins the app_rw DELETE grant list and 2B is its only extender.
 * `minQuantity` defaults to "0" (the no-break price) and `unitId` to null (the item's base unit).
 */
export async function replacePriceListLines(
  tx: Sql,
  priceListId: string,
  lines: readonly PriceListLineInput[],
): Promise<PriceListLineRow[]> {
  const keys = lines.map((l) => `${l.itemId}|${l.unitId ?? ""}|${normaliseBreak(l.minQuantity)}`);
  await tx`
    update app.price_list_line set archived_at = now()
     where price_list_id = ${priceListId} and archived_at is null
       and (item_id::text || '|' || coalesce(unit_id::text, '') || '|' || min_quantity::text) <> all(${keys})`;
  for (const line of lines) {
    await tx`
      insert into app.price_list_line
        (tenant_id, price_list_id, item_id, unit_id, min_quantity, unit_price)
      values (app.current_tenant(), ${priceListId}, ${line.itemId}, ${line.unitId ?? null},
              ${normaliseBreak(line.minQuantity)}, ${line.unitPrice})
      on conflict (price_list_id, item_id, unit_id, min_quantity)
      do update set unit_price = excluded.unit_price, archived_at = null`;
  }
  return listPriceListLines(tx, { priceListId });
}

export async function listPriceListLines(
  tx: Sql,
  params: { priceListId: string; includeArchived?: boolean },
): Promise<PriceListLineRow[]> {
  return tx<PriceListLineRow[]>`
    select id, price_list_id as "priceListId", item_id as "itemId", unit_id as "unitId",
           min_quantity::text as "minQuantity", unit_price::text as "unitPrice",
           archived_at::text as "archivedAt", created_at::text as "createdAt"
      from app.price_list_line
     where price_list_id = ${params.priceListId}
       and (${params.includeArchived ?? false} or archived_at is null)
     order by item_id, min_quantity, unit_id nulls first`;
}

export interface PriceQuery {
  companyId: string;
  itemId: string;
  currency: string;
  quantity: string;
  on: string;
  unitId?: string | null;
  customerKind?: string | null;
  branchId?: string | null;
}

export interface ResolvedPrice {
  priceListId: string;
  priceListCode: string;
  priceListLineId: string;
  unitId: string | null;
  minQuantity: string;
  unitPrice: string;
}

/**
 * The ONE price resolver. 3D's SALES_ORDER, 4A's SALES_INVOICE and 6B's till all call this, so a price is one
 * answer rather than three. Deterministic by construction: the ordering below is a total order on the candidate
 * set, so two calls with the same arguments return the same row even when two lists tie on specificity.
 *
 * Candidates: a non-archived list of the company, matching `currency`; window containing `on`; `branch_id` null
 * or equal to `branchId`; `customer_kind` null or equal to `customerKind`; with a non-archived line for the item
 * whose `unit_id` is null or equal to `unitId` and whose `min_quantity <= quantity`.
 * Most specific first: branch-specific, then trade-level-specific, then unit-specific, then the largest
 * quantity break, then the list code (the stable tiebreak).
 */
export async function resolvePrice(tx: Sql, q: PriceQuery): Promise<ResolvedPrice | null> {
  const [row] = await tx<ResolvedPrice[]>`
    select l.id                     as "priceListId",
           l.code                   as "priceListCode",
           n.id                     as "priceListLineId",
           n.unit_id                as "unitId",
           n.min_quantity::text     as "minQuantity",
           n.unit_price::text       as "unitPrice"
      from app.price_list l
      join app.price_list_line n
        on n.price_list_id = l.id and n.archived_at is null
     where l.company_id = ${q.companyId}
       and l.archived_at is null
       and l.currency = ${q.currency}
       and (l.valid_from is null or l.valid_from <= ${q.on}::date)
       and (l.valid_to   is null or l.valid_to   >= ${q.on}::date)
       and (l.branch_id  is null or l.branch_id = ${q.branchId ?? null})
       and (l.customer_kind is null or l.customer_kind = ${q.customerKind ?? null})
       and n.item_id = ${q.itemId}
       and (n.unit_id is null or n.unit_id = ${q.unitId ?? null})
       and n.min_quantity <= ${q.quantity}::numeric
     order by (l.branch_id is not null)     desc,
              (l.customer_kind is not null) desc,
              (n.unit_id is not null)       desc,
              n.min_quantity                desc,
              l.code                        asc
     limit 1`;
  return row ?? null;
}
