import { Money, Quantity, type CostingInput, type CurrencyCode } from "@dulja/domain";
import type { Sql } from "postgres";
import { PostingError } from "../posting/errors";

/** Resolve a full purchase reversal to its immutable source, including reinstatement chains. */
export async function purchaseCancellation(
  tx: Sql,
  input: {
    companyId: string;
    documentId: string;
    lineNo: number;
    itemId: string;
    warehouseId: string;
    lotId: string;
    quantity: Quantity;
    baseCurrency: CurrencyCode;
  },
): Promise<CostingInput["cancellation"]> {
  const rows = await tx<
    {
      id: string;
      item_id: string;
      warehouse_id: string;
      lot_id: string;
      quantity: string;
      value: string;
    }[]
  >`
    with recursive ancestry as (
      select o.id, o.reverses_document_id from app.document d
        join app.document o on o.tenant_id = d.tenant_id and o.id = d.reverses_document_id
       where d.company_id = ${input.companyId} and d.id = ${input.documentId}
      union
      select p.id, p.reverses_document_id from ancestry a
        join app.document p on p.id = a.reverses_document_id and p.company_id = ${input.companyId}
    )
    select m.id::text, m.item_id::text, m.warehouse_id::text, m.lot_id::text,
           m.quantity::text, abs(m.value)::text as value
      from app.document d
      join app.inventory_movement m on m.tenant_id = d.tenant_id and m.document_id = d.reverses_document_id
      join app.document_line l on l.tenant_id = m.tenant_id and l.document_id = m.document_id and l.line_no = m.line_no
     where d.company_id = ${input.companyId} and d.id = ${input.documentId}
       and m.company_id = ${input.companyId} and m.line_no = ${input.lineNo}
       and m.quantity > 0 and l.expected_quantity is null and l.counted_quantity is null
       and not exists (select 1 from app.inventory_movement other
                        where other.document_id = m.document_id and other.quantity < 0)
       and exists (select 1 from ancestry a where a.reverses_document_id is null
                    and exists (select 1 from app.inventory_movement root where root.document_id = a.id and root.quantity > 0)
                    and not exists (select 1 from app.inventory_movement root where root.document_id = a.id and root.quantity < 0)
                    and not exists (select 1 from app.document_line root where root.document_id = a.id and root.counted_quantity is not null))`;
  if (rows.length === 0) return undefined;
  const source = rows[0]!;
  if (
    rows.length !== 1 ||
    source.item_id !== input.itemId ||
    source.warehouse_id !== input.warehouseId ||
    source.lot_id !== input.lotId ||
    Quantity.of(source.quantity).compare(input.quantity) !== 0
  ) {
    throw new PostingError(
      "ERR_DOC_STATUS_ILLEGAL",
      "purchase reversal does not match its original receipt movement",
    );
  }
  return { movementId: source.id, value: Money.of(source.value, input.baseCurrency) };
}

/** A later cancellation must remain replayable after any newly back-dated issue. Called under stock locks. */
export async function assertCancellationChronology(
  tx: Sql,
  input: {
    companyId: string;
    itemId: string;
    warehouseId: string;
    effectiveDate: string;
    postingSeq: bigint;
    baseCurrency: CurrencyCode;
  },
): Promise<void> {
  const candidates = await tx<
    {
      document_id: string;
      line_no: number;
      item_id: string;
      warehouse_id: string;
      lot_id: string;
      quantity: string;
    }[]
  >`
      select cancellation.document_id::text, cancellation.line_no, cancellation.item_id::text,
             cancellation.warehouse_id::text, cancellation.lot_id::text, source.quantity::text
        from app.inventory_movement cancellation
        join app.document d on d.tenant_id = cancellation.tenant_id and d.id = cancellation.document_id
        join app.inventory_movement source on source.tenant_id = d.tenant_id and source.document_id = d.reverses_document_id
          and source.line_no = cancellation.line_no and source.item_id = cancellation.item_id
          and source.warehouse_id = cancellation.warehouse_id and source.lot_id = cancellation.lot_id
       where cancellation.company_id = ${input.companyId} and cancellation.item_id = ${input.itemId}
         and cancellation.warehouse_id = ${input.warehouseId} and cancellation.quantity < 0
         and source.quantity = -cancellation.quantity
         and (source.effective_date, source.posting_seq) <= (${input.effectiveDate}::date, ${input.postingSeq.toString()}::bigint)
         and (cancellation.effective_date, cancellation.posting_seq) > (${input.effectiveDate}::date, ${input.postingSeq.toString()}::bigint)`;
  for (const candidate of candidates) {
    const cancellation = await purchaseCancellation(tx, {
      companyId: input.companyId,
      documentId: candidate.document_id,
      lineNo: candidate.line_no,
      itemId: candidate.item_id,
      warehouseId: candidate.warehouse_id,
      lotId: candidate.lot_id,
      quantity: Quantity.of(candidate.quantity),
      baseCurrency: input.baseCurrency,
    });
    if (cancellation) {
      throw new PostingError(
        "ERR_DOC_STATUS_ILLEGAL",
        "back-dated issue crosses a purchase cancellation; use the ordinary correction or return path",
      );
    }
  }
}
