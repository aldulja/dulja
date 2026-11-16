import { Quantity } from "@dulja/domain";
import type { Sql } from "postgres";
import { setValues } from "../custom-fields/service";
import type { TenantContext } from "../with-tenant";

export interface ExpiryWriteOffInput {
  documentTypeId: string;
  series: string;
  effectiveDate: string;
  warehouseId: string;
  /** Written off in full unless a quantity is given — a partly-spoiled lot is the exception, not the rule. */
  lots: readonly { lotId: string; quantity?: string }[];
  reason: string;
}

export interface ExpiryWriteOffResult {
  documentId: string;
  lineIds: string[];
  totalQuantity: string;
}

/**
 * The custom-field code carrying the clerk's reason (ADR 0043's pattern, applied a second time). The plan
 * wrote this as `document.custom_fields.reason`; `app.document` carries no `custom_fields` jsonb bag in
 * this tree — §4.2.11's bag for a document header is `app.custom_field_value` keyed by a
 * `custom_field_definition` code, which is what `loadSnapshot` reads into
 * `DocumentSnapshot.header.customFields` and therefore what an accountant's review screen reads.
 */
export const WRITE_OFF_REASON_FIELD = "reason";

/** The `custom_field_definition` row `reason` hangs off, created on first use and never again. Data, not
 *  DDL (spec:97's ban is on DDL from application code): one row per company, `on conflict do nothing` so two
 *  concurrent drafts cannot collide on `unique (company_id, entity, code)`. */
async function ensureReasonDefinition(tx: Sql, companyId: string): Promise<string> {
  await tx`
    insert into app.custom_field_definition
      (tenant_id, company_id, entity, code, name_en, kind, required, indexed)
    values (app.current_tenant(), ${companyId}, 'document', ${WRITE_OFF_REASON_FIELD},
            'Reason', 'text', false, false)
    on conflict (company_id, entity, code) do nothing`;
  const [row] = await tx<{ id: string }[]>`
    select id from app.custom_field_definition
     where company_id = ${companyId} and entity = 'document' and code = ${WRITE_OFF_REASON_FIELD}`;
  return row!.id;
}

/**
 * The branch clerk's document. It writes `document` + `document_line` only (plus the one custom-field row
 * above); the accountant's approval and the post are transitions, gated by the policy's `approval.approve` /
 * `.post` (both `inventory.adjustment.approve`, which Task 2 granted to the accountant role and to nobody
 * who can draft).
 *
 * Quantities come from `stock_on_hand` for the (item, warehouse, lot) key, so "write off the lot" needs no
 * figure typed twice. A lot with nothing here is refused now rather than at post: `assert_stock_available`
 * would refuse it anyway, and a clerk should not discover that after an accountant has approved it.
 *
 * `packages/db` may not import `@dulja/contracts` (§3.1), so the refusals are `Error`s whose message begins
 * with the registry code, which the route layer's `asAppError` turns back into an `AppError`.
 */
export async function draftExpiryWriteOff(
  tx: Sql,
  ctx: TenantContext,
  input: ExpiryWriteOffInput,
): Promise<ExpiryWriteOffResult> {
  const [wh] = await tx<{ company_id: string; branch_id: string; kind: string; code: string }[]>`
    select company_id, branch_id, kind, code from app.warehouse
     where id = ${input.warehouseId} and archived_at is null`;
  if (wh === undefined) {
    throw new Error(`ERR_NOT_FOUND: warehouse ${input.warehouseId} is not visible`);
  }
  if (input.lots.length === 0) throw new Error("ERR_DOC_NO_LINES: a write-off names no lot");

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, branch_id)
    select ${ctx.tenantId}, ${wh.company_id}, ${input.documentTypeId}, ${input.series},
           ${input.effectiveDate}, c.base_currency, '1.00000000', ${input.warehouseId}, ${wh.branch_id}
      from app.company c where c.id = ${wh.company_id}
    returning id`;
  const documentId = doc!.id;

  const lineIds: string[] = [];
  // `Quantity`, not a `number`: `totalQuantity` crosses this function's boundary and Global Constraint 4
  // forbids a `number` holding a quantity that does (spec:2041-2043, §3.7.5 `no-number-money`).
  let total = Quantity.zero();
  for (let i = 0; i < input.lots.length; i += 1) {
    const l = input.lots[i]!;
    const [key] = await tx<
      { item_id: string; base_unit_id: string; on_hand: string; lot_code: string }[]
    >`
      select h.item_id, i.base_unit_id, h.quantity::text as on_hand, lo.code as lot_code
        from app.stock_on_hand h
        join app.item i  on i.id  = h.item_id
        join app.lot  lo on lo.id = h.lot_id
       where h.lot_id = ${l.lotId} and h.warehouse_id = ${input.warehouseId} and h.quantity > 0`;
    if (key === undefined) {
      const [lot] = await tx<{ code: string }[]>`select code from app.lot where id = ${l.lotId}`;
      throw new Error(
        `ERR_VALIDATION_FAILED: lot ${lot?.code ?? l.lotId} has no stock in warehouse ${wh.code}`,
      );
    }
    const quantity = l.quantity ?? key.on_hand;
    if (Quantity.of(quantity).compare(Quantity.of(key.on_hand)) > 0) {
      throw new Error(
        `ERR_VALIDATION_FAILED: lot ${key.lot_code} holds ${key.on_hand} in warehouse ${wh.code}; cannot write off ${quantity}`,
      );
    }
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id,
         quantity, amount)
      values (${ctx.tenantId}, ${wh.company_id}, ${documentId}, ${i + 1}, 'item', ${key.item_id},
              ${input.warehouseId}, ${l.lotId}, ${key.base_unit_id}, ${quantity}, 0)
      returning id`;
    lineIds.push(row!.id);
    total = total.add(Quantity.of(quantity));
  }

  const definitionId = await ensureReasonDefinition(tx, wh.company_id);
  const written = await setValues(tx, wh.company_id, "document", documentId, [
    { definitionId, value: input.reason },
  ]);
  if (!written.ok) {
    throw new Error(
      `ERR_VALIDATION_FAILED: the write-off's reason could not be recorded (${written.errors
        .map((e) => e.message)
        .join("; ")})`,
    );
  }

  return { documentId, lineIds, totalQuantity: total.toString() };
}
