import type { Sql } from "postgres";
import { setValues } from "../custom-fields/service";
import { linkFulfilment, openQuantity } from "../documents/link";
import { resolvePolicy } from "../posting/load";
import { transferLegOf, type TransferLeg } from "./transfer-shape";
import type { TenantContext } from "../with-tenant";

export interface TransferInput {
  /** The dispatching warehouse. Every line ships from here. */
  fromWarehouseId: string;
  /**
   * The FINAL destination — a `kind = 'stock'` warehouse at the receiving branch. NOT the in-transit one:
   * the caller names where the goods are going and this service resolves the corridor they travel through.
   */
  toWarehouseId: string;
  effectiveDate: string;
  series: string;
  documentTypeId: string;
  lines: readonly { itemId: string; unitId: string; lotId?: string | null; quantity: string }[];
}

export interface TransferResult {
  documentId: string;
  lineIds: string[];
  inTransitWarehouseId: string;
}

/**
 * The custom-field code that carries a dispatch's ultimate destination between the two legs of a transfer
 * (ADR 0043 decision 3). It is a `document` custom field, not a header column: `app.document` has no
 * `custom_fields` jsonb bag in this tree — §4.2.11's bag for a document header is `app.custom_field_value`
 * keyed by a `custom_field_definition` code, which is exactly what `loadSnapshot` reads into
 * `DocumentSnapshot.header.customFields`. One uuid does not earn a column (§4.3.4 is frozen), and the
 * receipt leg is the only reader.
 */
export const FINAL_WAREHOUSE_FIELD = "final_warehouse_id";

/**
 * The in-transit warehouse a dispatch to `toWarehouseId` travels through: the `kind = 'in_transit'`
 * warehouse whose `branch_id` equals the destination's branch. ONE per receiving branch (ADR 0043): the
 * question a branch manager asks is "what is on its way to me", and the answer must not be spread over one
 * row per sending branch.
 *
 * A missing in-transit warehouse RAISES rather than falling back to the destination. Falling back would post
 * the goods straight into the receiving warehouse, which is arithmetically fine and makes the definition-of-
 * done clause quietly false — the destination's on-hand would rise before anyone received anything.
 *
 * **Company-bound, and answerable by the sending branch (ADR 0043's amendment, accepted 2026-11-04).** Both
 * reads are bound to `companyId` — the dispatch's company, the source warehouse's — because RLS bounds the
 * tenant and nothing else. A principal restricted to the SENDING branch cannot see the destination: it is a
 * stock warehouse of another branch, which Form A″ shows only to its own. For that case alone the destination's
 * branch comes from `app.transfer_destination_branch` (migration 0119), a bounded lookup that answers one fact
 * — the branch of a live stock warehouse of this company — to a principal holding a live role in it. The
 * corridor itself needs nothing: Form A″ shows every in-transit warehouse to every branch.
 *
 * `packages/db` may not import `@dulja/contracts` (§3.1), so the refusals are `Error`s whose message begins
 * with the registry code, which the route layer's `asAppError` turns back into an `AppError`.
 */
export async function resolveInTransitWarehouse(
  tx: Sql,
  toWarehouseId: string,
  companyId: string,
): Promise<string> {
  const [destination] = await tx<{ branch_id: string; kind: string; code: string }[]>`
    select branch_id, kind, code from app.warehouse
     where id = ${toWarehouseId} and company_id = ${companyId} and archived_at is null`;
  let branchId: string;
  let label: string;
  if (destination !== undefined) {
    if (destination.kind !== "stock") {
      throw new Error(
        `ERR_VALIDATION_FAILED: warehouse ${destination.code} is ${destination.kind}; a transfer destination must be a stock warehouse`,
      );
    }
    branchId = destination.branch_id;
    label = destination.code;
  } else {
    // Hidden from the caller. An in-transit warehouse never is (Form A″), so the lookup answers only for a
    // stock warehouse, and only its branch: nothing about the row the caller could not already infer from
    // the corridor it is about to write into.
    const [hidden] = await tx<{ branch_id: string | null }[]>`
      select app.transfer_destination_branch(${companyId}::uuid, ${toWarehouseId}::uuid) as branch_id`;
    if (hidden === undefined || hidden.branch_id === null) {
      throw new Error(`ERR_NOT_FOUND: warehouse ${toWarehouseId} is not visible`);
    }
    branchId = hidden.branch_id;
    label = toWarehouseId;
  }
  const [transit] = await tx<{ id: string }[]>`
    select id from app.warehouse
     where company_id = ${companyId} and branch_id = ${branchId} and kind = 'in_transit'
       and archived_at is null
     order by code
     limit 1`;
  if (transit === undefined) {
    throw new Error(
      `ERR_VALIDATION_FAILED: branch ${branchId} has no in_transit warehouse; configure one before transferring to ${label}`,
    );
  }
  return transit.id;
}

/** The `custom_field_definition` row `final_warehouse_id` hangs off, created on first use and never again.
 *  Data, not DDL (spec:97's ban is on DDL from application code): one row per company, `on conflict do
 *  nothing` so two concurrent dispatches cannot collide on `unique (company_id, entity, code)`. */
async function ensureFinalWarehouseDefinition(tx: Sql, companyId: string): Promise<string> {
  await tx`
    insert into app.custom_field_definition
      (tenant_id, company_id, entity, code, name_en, kind, required, indexed)
    values (app.current_tenant(), ${companyId}, 'document', ${FINAL_WAREHOUSE_FIELD},
            'Final destination warehouse', 'text', false, false)
    on conflict (company_id, entity, code) do nothing`;
  const [row] = await tx<{ id: string }[]>`
    select id from app.custom_field_definition
     where company_id = ${companyId} and entity = 'document' and code = ${FINAL_WAREHOUSE_FIELD}`;
  return row!.id;
}

/** The ultimate destination a `TRANSFER` was dispatched to, or null when the document carries none. The
 *  receipt leg (Task 8) reads it to know where the goods finally belong. Bounded by `companyId` for the
 *  same reason `getValues` is: `custom_field_value` borrows its company through its definition. */
export async function finalWarehouseOf(
  tx: Sql,
  companyId: string,
  documentId: string,
): Promise<string | null> {
  const [row] = await tx<{ value: unknown }[]>`
    select value.value from app.custom_field_value value
      join app.custom_field_definition definition on definition.id = value.definition_id
     where value.entity_id = ${documentId} and definition.company_id = ${companyId}
       and definition.entity = 'document' and definition.code = ${FINAL_WAREHOUSE_FIELD}`;
  return typeof row?.value === "string" ? row.value : null;
}

/** Refuses, before anything is written, a type whose policy at `effectiveDate` — resolved exactly as
 *  §4.3.2 step 4 will resolve it at post — is not the `leg` the calling service drafts. */
async function assertTransferLeg(
  tx: Sql,
  documentTypeId: string,
  effectiveDate: string,
  leg: TransferLeg,
): Promise<void> {
  const { definition } = await resolvePolicy(tx, documentTypeId, effectiveDate);
  if (transferLegOf(definition) === leg) return;
  throw new Error(
    leg === "dispatch"
      ? `ERR_VALIDATION_FAILED: document type ${definition.documentType} is not a transfer dispatch: its policy must declare inventory.effect "transfer" and credit item.inventory_account, which the goods leave, on every rule that names it`
      : `ERR_VALIDATION_FAILED: document type ${definition.documentType} is not a transfer receipt: its policy must declare inventory.effect "transfer" and debit item.inventory_account, which the goods enter, on every rule that names it`,
  );
}

/**
 * Drafts the dispatch. Runs inside the caller's transaction and writes `document` + `document_line` only
 * (plus the one custom-field row below); the caller issues and posts.
 *
 * `document.to_warehouse_id` is the IN-TRANSIT warehouse, because that is what the policy's
 * `to_warehouse: "header.to_warehouse"` resolves to and therefore where the receipt movement lands. The
 * ultimate destination goes into the `final_warehouse_id` document custom field: Task 8's receipt reads it
 * to know where the goods finally belong, and one uuid does not earn a column (§4.2.11).
 *
 * `document_line.lot_id` may be null — `applyMovements` resolves the item's `NONE` sentinel (SAH-050). A
 * lot-tracked item's caller passes the lot it physically loaded; FEFO is a picking decision that belongs to
 * whatever drafts the line, exactly as it does for a delivery.
 */
export async function draftTransfer(
  tx: Sql,
  ctx: TenantContext,
  input: TransferInput,
): Promise<TransferResult> {
  await assertTransferLeg(tx, input.documentTypeId, input.effectiveDate, "dispatch");
  // The SOURCE first: it fixes the dispatch's company and branch (ADR 0043's amendment — the create stage is
  // gated at this branch), and the destination is then resolved inside that company.
  const [source] = await tx<
    { company_id: string; branch_id: string; kind: string; code: string }[]
  >`
    select company_id, branch_id, kind, code from app.warehouse
     where id = ${input.fromWarehouseId} and archived_at is null`;
  if (source === undefined) {
    throw new Error(`ERR_NOT_FOUND: warehouse ${input.fromWarehouseId} is not visible`);
  }
  // The goods leave a STOCK warehouse: the dispatch credits item.inventory_account, and goods already in a
  // corridor are 1310's (the verification of R3 — a dispatch out of WH-BR2-TR posted Dr 1310 / Cr 1300 with
  // no stock warehouse's value moving). `postDocument` step 6f asks the same of every transfer; this is the
  // early refusal, before anything is written.
  if (source.kind !== "stock") {
    throw new Error(
      `ERR_VALIDATION_FAILED: warehouse ${source.code} is ${source.kind}; a transfer's source must be a stock warehouse`,
    );
  }
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new Error(
      `ERR_VALIDATION_FAILED: a transfer's source and destination are the same warehouse (${source.code})`,
    );
  }
  const inTransitWarehouseId = await resolveInTransitWarehouse(
    tx,
    input.toWarehouseId,
    source.company_id,
  );

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, to_warehouse_id, branch_id)
    select ${ctx.tenantId}, ${source.company_id}, ${input.documentTypeId}, ${input.series},
           ${input.effectiveDate}, c.base_currency, '1.00000000',
           ${input.fromWarehouseId}, ${inTransitWarehouseId}, ${source.branch_id}
      from app.company c where c.id = ${source.company_id}
    returning id`;
  const documentId = doc!.id;

  const lineIds: string[] = [];
  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i]!;
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id,
         quantity, amount)
      values (${ctx.tenantId}, ${source.company_id}, ${documentId}, ${i + 1}, 'item', ${line.itemId},
              ${input.fromWarehouseId}, ${line.lotId ?? null}, ${line.unitId}, ${line.quantity}, 0)
      returning id`;
    lineIds.push(row!.id);
  }

  const definitionId = await ensureFinalWarehouseDefinition(tx, source.company_id);
  const written = await setValues(tx, source.company_id, "document", documentId, [
    { definitionId, value: input.toWarehouseId },
  ]);
  if (!written.ok) {
    throw new Error(
      `ERR_VALIDATION_FAILED: the transfer's final destination could not be recorded (${written.errors
        .map((e) => e.message)
        .join("; ")})`,
    );
  }

  return { documentId, lineIds, inTransitWarehouseId };
}

export interface TransferReceiptInput {
  /** The posted `TRANSFER` being received. Its `to_warehouse_id` is the corridor and its
   *  `final_warehouse_id` custom field the destination — both READ here, neither passed in, so a receipt
   *  cannot be pointed at a warehouse the goods never travelled to. */
  transferDocumentId: string;
  documentTypeId: string;
  series: string;
  effectiveDate: string;
  /** What actually arrived, per dispatch line. A line omitted arrives in full — its whole open quantity. A
   *  line named here must still have something open; a line with nothing open is not drafted at all. */
  received?: readonly { transferLineId: string; countedQuantity: string }[];
}

export interface TransferReceiptResult {
  documentId: string;
  lineIds: string[];
  finalWarehouseId: string;
}

/**
 * 3D T8 — the receive leg (spec:1053). Reads the dispatch rather than trusting the caller.
 *
 * Each drafted line carries THREE quantities and they are written in ONE statement, which is what makes the
 * variance impossible to desynchronise:
 *   `expected_quantity` = what is still OPEN on the dispatch line (INV-01: a line is received at most once)
 *   `counted_quantity`  = what arrived (the dispatched quantity when `received` omits the line)
 *   `quantity`          = counted − expected, the SIGNED variance the policy's `when` rules read
 * The evaluator's `transferQuantities` then gives movement 1 the expected quantity (out of the corridor)
 * and movement 2 the counted one (into the branch), and `applyMovements` fills `line.cost` from the receipt
 * leg and `line.variance_value` from the difference.
 *
 * `document.warehouse_id` is the CORRIDOR (movement 1 issues from it) and `document.to_warehouse_id` is the
 * FINAL warehouse (movement 2 receives into it, through the policy's `to_warehouse: "header.to_warehouse"`).
 * The dispatch and the receipt therefore use the same policy shape with the two warehouses swapped in
 * meaning — no second effect and no second policy key.
 *
 * `document.branch_id` is the CORRIDOR's branch — the receiving branch — not the dispatch's (ADR 0043's
 * amendment, accepted by the owner 2026-11-04). Under decision 1 the corridor and the final warehouse are
 * always the same branch, so the receipt is that branch's document end to end: Form A admits it to a principal
 * restricted to that branch, and the route and 2B's status trigger gate it there.
 *
 * **A dispatch line is received at most once in total** (full review 2026-11-15, INV-01). Each line links its
 * whole expected quantity — arrival, shortfall, overage and total loss alike — so a live receipt leaves
 * nothing open, and a receipt of a dispatch with nothing open is refused `ERR_DOC_LINK_OVER_FULFILLED`. A void
 * receipt releases what it took, and the dispatch receives again.
 *
 * `packages/db` may not import `@dulja/contracts` (§3.1): every refusal is a plain `Error` whose message
 * begins with the registry code, translated by the route layer's `asAppError`.
 */
export async function draftTransferReceipt(
  tx: Sql,
  ctx: TenantContext,
  input: TransferReceiptInput,
): Promise<TransferReceiptResult> {
  await assertTransferLeg(tx, input.documentTypeId, input.effectiveDate, "receipt");
  const [transfer] = await tx<
    {
      id: string;
      company_id: string;
      status: string;
      currency: string;
      exchange_rate: string;
      to_warehouse_id: string | null;
    }[]
  >`
    select id, company_id, status, currency, exchange_rate::text as exchange_rate, to_warehouse_id
      from app.document where id = ${input.transferDocumentId}
       for share`;
  // `for share` (ORCH-03, full review 2026-11-15), as `convertToInvoice` reads its source: `reverseDocument`
  // locks the dispatch `for update`, so a receipt drafted during an uncommitted reversal waits here and then
  // reads `reversed`, and a reversal started during a receipt draft waits for it and then sees its link.
  if (transfer === undefined) {
    throw new Error(`ERR_NOT_FOUND: document ${input.transferDocumentId} is not visible`);
  }
  if (transfer.status !== "posted") {
    throw new Error(
      `ERR_VALIDATION_FAILED: transfer ${input.transferDocumentId} is ${transfer.status}; ` +
        `only a posted transfer can be received`,
    );
  }
  // The ultimate destination lives in the `final_warehouse_id` DOCUMENT CUSTOM FIELD, not in a header
  // column: `app.document` has no `custom_fields` jsonb bag in this tree (see `FINAL_WAREHOUSE_FIELD`).
  const finalWarehouseId = await finalWarehouseOf(
    tx,
    transfer.company_id,
    input.transferDocumentId,
  );
  // The corridor's branch is the RECEIVING branch (decision 1), and it is the branch the receipt carries (ADR
  // 0043's amendment, accepted 2026-11-04): the receipt is the receiving branch's document, gated there by the
  // route and, at post, by 2B's status trigger. A principal restricted to that branch reads the dispatch at all
  // only because it is a posted document into this corridor (migration 0119's one widened read of Form A).
  const [corridor] =
    transfer.to_warehouse_id === null
      ? []
      : await tx<{ branch_id: string }[]>`
          select branch_id from app.warehouse
           where id = ${transfer.to_warehouse_id} and company_id = ${transfer.company_id}
             and kind = 'in_transit'`;
  if (transfer.to_warehouse_id === null || corridor === undefined || finalWarehouseId === null) {
    throw new Error(
      `ERR_VALIDATION_FAILED: transfer ${input.transferDocumentId} carries no in-transit or final ` +
        `warehouse; it was not drafted by draftTransfer`,
    );
  }
  const inTransitWarehouseId = transfer.to_warehouse_id;

  const dispatchLines = await tx<
    {
      id: string;
      line_no: number;
      item_id: string | null;
      lot_id: string | null;
      unit_id: string | null;
      quantity: string;
    }[]
  >`
    select id, line_no, item_id, lot_id, unit_id, quantity::text as quantity
      from app.document_line where document_id = ${input.transferDocumentId} order by line_no`;
  const counted = new Map((input.received ?? []).map((r) => [r.transferLineId, r.countedQuantity]));
  for (const id of counted.keys()) {
    if (!dispatchLines.some((l) => l.id === id)) {
      throw new Error(
        `ERR_NOT_FOUND: document line ${id} is not a line of document ${input.transferDocumentId}`,
      );
    }
  }

  // Lock order (code review 4, item 3): every dispatch line is linked below, so each one's
  // `document_link:<line>` key — the key 0037's link guard takes — is taken BEFORE the first audited write,
  // whose audit row takes the tenant's `tenant-serial:` key (0010). That is the order reverseDocument keeps
  // when a reversal reinstates a claim on the line; taken only by the guard at linkFulfilment's INSERT, the
  // keys came after the tenant's and the two could deadlock. Sorted, as linkFulfilment, convertToInvoice and
  // creditNoteFrom sort them; the guard's later lock on the same key is re-entrant.
  for (const id of dispatchLines.map((l) => l.id).toSorted()) {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`document_link:${id}`}, 0))`;
  }

  // What is still OPEN on each dispatch line, read AFTER its lock (full review 2026-11-15, INV-01). A receipt
  // line takes out of transit, and links, exactly this figure: what arrived and what was lost alike, so a
  // dispatch line is received at most once in total. A live receipt's link holds it (a total loss included —
  // it links the open quantity, never NULL); a void receipt, or a reversed one whose chain nets, releases it
  // (0116's `document_open_quantity`, the link guard's own rule). Read at READ COMMITTED after the lock, so a
  // concurrent receipt that committed while the lock was waited on is seen.
  // Through 3C's `openQuantity`, the one reader of the view (SAH-017's "open quantity defined once").
  const openOf = new Map(
    (await openQuantity(tx, input.transferDocumentId)).map((r) => [
      r.documentLineId,
      r.openQuantity,
    ]),
  );
  // A numeric(19,6) text is positive when it is unsigned and carries a non-zero digit; no `number` touches it.
  const isOpen = (id: string): boolean => {
    const open = openOf.get(id);
    return open !== undefined && !open.startsWith("-") && /[1-9]/.test(open);
  };
  for (const id of counted.keys()) {
    if (!isOpen(id)) {
      throw new Error(
        `ERR_DOC_LINK_OVER_FULFILLED: dispatch line ${id} of transfer ${input.transferDocumentId} has ` +
          `nothing open to receive; it was already received`,
      );
    }
  }
  const openLines = dispatchLines.filter((l) => isOpen(l.id));
  if (openLines.length === 0) {
    throw new Error(
      `ERR_DOC_LINK_OVER_FULFILLED: transfer ${input.transferDocumentId} has nothing open to receive; ` +
        `it was already received (void the earlier receipt to receive it again)`,
    );
  }

  const [doc] = await tx<{ id: string }[]>`
    insert into app.document
      (tenant_id, company_id, document_type_id, series, effective_date, currency, exchange_rate,
       warehouse_id, to_warehouse_id, branch_id)
    values (${ctx.tenantId}, ${transfer.company_id}, ${input.documentTypeId}, ${input.series},
            ${input.effectiveDate}, ${transfer.currency}, ${transfer.exchange_rate},
            ${inTransitWarehouseId}, ${finalWarehouseId}, ${corridor.branch_id})
    returning id`;
  const documentId = doc!.id;

  const lineIds: string[] = [];
  const links: { sourceLineId: string; targetLineId: string; quantity: string | null }[] = [];
  for (const dispatchLine of openLines) {
    // `expected` is what is still OPEN on the dispatch line — a positive magnitude, as the dispatch line's
    // quantity is (the movement carries the sign). On a dispatch no live receipt holds, that is the
    // dispatched quantity as written.
    const expected = openOf.get(dispatchLine.id)!;
    const arrived = counted.get(dispatchLine.id) ?? expected;
    const [row] = await tx<{ id: string }[]>`
      insert into app.document_line
        (tenant_id, company_id, document_id, line_no, kind, item_id, warehouse_id, lot_id, unit_id,
         quantity, counted_quantity, expected_quantity, amount)
      values (${ctx.tenantId}, ${transfer.company_id}, ${documentId}, ${dispatchLine.line_no}, 'item',
              ${dispatchLine.item_id}, ${inTransitWarehouseId}, ${dispatchLine.lot_id},
              ${dispatchLine.unit_id},
              (${arrived}::numeric(19,6) - ${expected}::numeric(19,6)), ${arrived}, ${expected}, 0)
      returning id`;
    lineIds.push(row!.id);
    // The LINK records what this receipt ACCOUNTS FOR on the dispatch line: the whole expected (open)
    // quantity, whether it arrived, partly arrived or was lost (full review 2026-11-15, INV-01; ADR 0043's
    // 2026-11-15 amendment). What never arrived is the line's variance (counted − expected, posted to 5110),
    // not a residual open quantity: a residual let a second receipt take the "missing" units out of the
    // corridor again — out of another dispatch's goods. An OVERAGE also links at the expected quantity, since
    // more arriving than left is a variance and never a larger fulfilment (0037 refuses linked > ordered). A
    // TOTAL LOSS links the expected quantity too: it used to link NULL (the link table refuses 0.000000), and
    // the guard does not bound a NULL link, so the dispatch stayed fully open and could be received again.
    links.push({ sourceLineId: dispatchLine.id, targetLineId: row!.id, quantity: expected });
  }

  await linkFulfilment(tx, ctx, {
    sourceDocumentId: input.transferDocumentId,
    targetDocumentId: documentId,
    linkKind: "receives_against",
    lines: links,
    priceFromSource: false,
  });
  return { documentId, lineIds, finalWarehouseId };
}
