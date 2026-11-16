import type { Sql } from "postgres";
import { resolvePolicy } from "../posting/load";
import type { TenantContext } from "../with-tenant";

/**
 * 3D T8 — the `STOCK_COUNT` sheet (spec:1052, 2026).
 *
 * A count sheet is not a report: it is a `document` whose `document_line` rows carry
 * `expected_quantity` (migration 0040's snapshot of `app.stock_on_hand` at sheet time) and, once a counter
 * has been round the shelves, `counted_quantity`. `quantity` on such a line is the SIGNED variance
 * `counted − expected`, which is what makes "post only the variance" a policy fact rather than a special
 * case in the posting service: a line whose count matches has a zero variance, `line.quantity_sign` is
 * null, neither `when` rule matches, and the evaluator's zero-drop removes its movement.
 *
 * `packages/db` may not import `@dulja/contracts` (§3.1), so every refusal is a plain `Error` whose message
 * begins with the registry code; the route layer's `asAppError` turns it back into an `AppError`.
 */

export interface CountSheetLine {
  documentLineId: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  warehouseId: string;
  lotId: string;
  lotCode: string;
  /** The `stock_on_hand` snapshot taken when the sheet was drafted. */
  expectedQuantity: string;
  /** Null until a counter enters a figure. */
  countedQuantity: string | null;
  /** `document_line.quantity` — null while `countedQuantity` is null. */
  variance: string | null;
}

export interface SnapshotCountSheetInput {
  documentTypeId: string;
  series: string;
  effectiveDate: string;
  warehouseId: string;
  /** Restrict the sheet to these items. Empty means every item with a `stock_on_hand` row in the warehouse
   *  — a full count. A cycle count passes a subset (spec:1052 names both). */
  itemIds?: readonly string[];
  /** Include keys whose projected quantity is zero. Default false: a full sheet of a large warehouse would
   *  otherwise carry every item ever stocked there. A counter who finds stock on a zero key adds the line. */
  includeZero?: boolean;
}

/**
 * Drafts a `STOCK_COUNT` and one line per (item, warehouse, lot) key from the SYNCHRONOUS `stock_on_hand`
 * projection (§4.7.3), writing `expected_quantity` and leaving `counted_quantity` and `quantity` NULL.
 * Nothing about the sheet is a count yet; `recordCounts` is what makes it one.
 *
 * Reading the projection rather than re-summing `inventory_movement` is 1B's rule and the reason test 2
 * exists: a sheet that quietly re-aggregated would hide the very drift the count is meant to find.
 *
 * Writes `document` and `document_line` only — it issues nothing, posts nothing and sets no `cost`
 * (§4.7.2's `applyMovements` is the only writer of that column).
 */
export async function snapshotCountSheet(
  tx: Sql,
  ctx: TenantContext,
  input: SnapshotCountSheetInput,
): Promise<{ documentId: string; lines: CountSheetLine[] }> {
  const [warehouse] = await tx<
    { company_id: string; branch_id: string; kind: string; code: string }[]
  >`
    select company_id, branch_id, kind, code from app.warehouse
     where id = ${input.warehouseId} and archived_at is null`;
  if (warehouse === undefined) {
    throw new Error(`ERR_NOT_FOUND: warehouse ${input.warehouseId} is not visible`);
  }
  if (warehouse.kind !== "stock") {
    throw new Error(
      `ERR_VALIDATION_FAILED: warehouse ${warehouse.code} is ${warehouse.kind}; only a stock warehouse is counted`,
    );
  }

  // `itemIds` empty means "every key"; the boolean is bound rather than the predicate built, because
  // `no-sql-concat` (§3.7.5) forbids assembling SQL from strings and a bound flag reads the same to the
  // planner as two statements would.
  const everyItem = input.itemIds === undefined || input.itemIds.length === 0;
  const chosenItems = [...(input.itemIds ?? [])];
  const withZero = input.includeZero ?? false;
  const keys = await tx<
    { item_id: string; item_code: string; lot_id: string; lot_code: string; quantity: string }[]
  >`
    select h.item_id, i.code as item_code, h.lot_id, l.code as lot_code, h.quantity::text as quantity
      from app.stock_on_hand h
      join app.item i on i.id = h.item_id
      join app.lot  l on l.id = h.lot_id
     where h.warehouse_id = ${input.warehouseId}
       and (${everyItem} or h.item_id = any(${chosenItems}::uuid[]))
       and (${withZero} or h.quantity <> 0)
     order by i.code, l.code`;
  if (keys.length === 0) {
    throw new Error(`ERR_DOC_NO_LINES: warehouse ${warehouse.code} has no stock to count`);
  }

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, branch_id)
    select ${ctx.tenantId}, ${warehouse.company_id}, ${input.documentTypeId}, ${input.series},
           ${input.effectiveDate}, c.base_currency, '1.00000000', ${input.warehouseId},
           ${warehouse.branch_id}
      from app.company c where c.id = ${warehouse.company_id}
    returning id`;
  const documentId = doc!.id;

  const lines: CountSheetLine[] = [];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id,
         quantity, counted_quantity, expected_quantity, amount)
      select ${ctx.tenantId}, ${warehouse.company_id}, ${documentId}, ${i + 1}, 'item', ${key.item_id},
             ${input.warehouseId}, ${key.lot_id}, i.base_unit_id, null, null, ${key.quantity}, 0
        from app.item i where i.id = ${key.item_id}
      returning id`;
    lines.push({
      documentLineId: row!.id,
      lineNo: i + 1,
      itemId: key.item_id,
      itemCode: key.item_code,
      warehouseId: input.warehouseId,
      lotId: key.lot_id,
      lotCode: key.lot_code,
      expectedQuantity: key.quantity,
      countedQuantity: null,
      variance: null,
    });
  }
  return { documentId, lines };
}

/**
 * **The sole writer of `counted_quantity` and of `quantity` on a counted line.** Both columns move in ONE
 * statement, computed in SQL from the row's own `expected_quantity`, so the variance cannot disagree with
 * its operands and no caller can set one without the other.
 *
 * A CHECK constraint could not express this: the triple is null-null-null on every other document type in
 * the system, and a reversal carries a negated `quantity` with no count columns at all (§4.5.1's reversal
 * shape). The enforcement is therefore structural — this function and `draftTransferReceipt` are the only
 * two that ever write `counted_quantity`.
 *
 * Refuses unless the sheet is a `draft` (`ERR_DOC_STATUS_ILLEGAL`): a submitted sheet is evidence. A line
 * this call does not name keeps its NULL counted quantity and plans nothing at all.
 *
 * **Count sheets only** (full review 2026-11-15, INV-05). A `TRANSFER_RECEIPT` line carries the same two count
 * columns, but its counted quantity is fixed when `draftTransferReceipt` drafts it, beside the dispatch link it
 * is accounted against; rewriting it here moved goods behind that link. So the document must be a count sheet
 * by policy SHAPE (3C's rule — never by type code): no transfer effect, and the target of no fulfilment link. A
 * mistaken receipt is voided and drafted again.
 */
export async function recordCounts(
  tx: Sql,
  ctx: TenantContext,
  input: {
    documentId: string;
    counts: readonly { documentLineId: string; countedQuantity: string }[];
  },
): Promise<CountSheetLine[]> {
  const [doc] = await tx<
    { status: string; document_type_id: string; effective_date: string; linked: boolean }[]
  >`
    select d.status, d.document_type_id, d.effective_date::text as effective_date,
           exists (select 1 from app.document_link l where l.target_document_id = d.id) as linked
      from app.document d
     where d.id = ${input.documentId} and d.tenant_id = ${ctx.tenantId}`;
  if (doc === undefined) {
    throw new Error(`ERR_NOT_FOUND: document ${input.documentId} is not visible`);
  }
  const { definition } = await resolvePolicy(tx, doc.document_type_id, doc.effective_date);
  if (definition.inventory.effect === "transfer" || doc.linked) {
    throw new Error(
      `ERR_VALIDATION_FAILED: document ${input.documentId} (${definition.documentType}) is not a stock-count ` +
        `sheet; its counted quantities are fixed when it is drafted — void it and draft it again`,
    );
  }
  if (doc.status !== "draft") {
    throw new Error(
      `ERR_DOC_STATUS_ILLEGAL: count sheet ${input.documentId} is ${doc.status}; ` +
        `counted quantities may only be entered on a draft`,
    );
  }
  for (const entry of input.counts) {
    const affected = await tx`
      update app.document_line
         set counted_quantity = ${entry.countedQuantity}::numeric(19,6),
             quantity         = ${entry.countedQuantity}::numeric(19,6) - expected_quantity
       where id = ${entry.documentLineId}
         and document_id = ${input.documentId}
         and tenant_id = ${ctx.tenantId}
         and expected_quantity is not null`;
    if (affected.count === 0) {
      throw new Error(
        `ERR_NOT_FOUND: document line ${entry.documentLineId} is not a count line of document ${input.documentId}`,
      );
    }
  }
  return readCountSheet(tx, input.documentId);
}

/** The sheet in `line_no` order — the count screen's list and the runbook's printout. */
export async function readCountSheet(tx: Sql, documentId: string): Promise<CountSheetLine[]> {
  const rows = await tx<
    {
      id: string;
      line_no: number;
      item_id: string;
      item_code: string;
      warehouse_id: string;
      lot_id: string;
      lot_code: string;
      expected: string;
      counted: string | null;
      variance: string | null;
    }[]
  >`
    select dl.id, dl.line_no, dl.item_id, i.code as item_code, dl.warehouse_id, dl.lot_id,
           l.code as lot_code, dl.expected_quantity::text as expected,
           dl.counted_quantity::text as counted, dl.quantity::text as variance
      from app.document_line dl
      join app.item i on i.id = dl.item_id
      join app.lot  l on l.id = dl.lot_id
     where dl.document_id = ${documentId} and dl.expected_quantity is not null
     order by dl.line_no`;
  return rows.map((r) => ({
    documentLineId: r.id,
    lineNo: r.line_no,
    itemId: r.item_id,
    itemCode: r.item_code,
    warehouseId: r.warehouse_id,
    lotId: r.lot_id,
    lotCode: r.lot_code,
    expectedQuantity: r.expected,
    countedQuantity: r.counted,
    variance: r.variance,
  }));
}
