import {
  currency,
  Money,
  Quantity,
  toBase,
  type CurrencyCode,
  type ExchangeRate,
  type LineSnapshot,
} from "@dulja/domain";
import type { Sql } from "postgres";
import type { TenantContext } from "../with-tenant";

export type LandedCostMethod = "by_value" | "by_quantity" | "by_weight";

/** One goods line as a candidate for a share. `weightKg` is the §4.2.11 custom field `weight_kg`. */
export interface AllocationTarget {
  lineId: string;
  /** document currency, excl. tax (§4.3.4) */
  amount: Money;
  quantity: Quantity | null;
  weightKg: Quantity | null;
}

/** One computed share. `weight` is the BASIS, returned for display and never stored (SAH-017, SAH-018). */
export interface AllocationShare {
  costLineId: string;
  targetLineId: string;
  method: LandedCostMethod;
  amount: Money;
  weight: bigint;
}

export interface LandedCostRow {
  id: string;
  costLineId: string;
  targetLineId: string;
  method: LandedCostMethod;
  /** document currency, 4 dp */
  allocatedAmount: string;
  createdAt: string;
}

export interface AllocateLandedCostInput {
  documentId: string;
  allocations: readonly { costLineId: string; method: LandedCostMethod }[];
}

/**
 * `packages/db` may not import `AppError` (§3.1), so this takes `CostingError`'s shape exactly (3B amendment
 * A2a): one class, codes that are literal members of `ErrCode`, reaching the same `asAppError` branch as
 * `PolicyEvaluationError` and `PostingError` (§4.2.4). No new `ERR_*` row is needed.
 */
export class LandedCostError extends Error {
  constructor(
    readonly code: "ERR_VALIDATION_FAILED" | "ERR_NOT_FOUND",
    readonly detail: string,
  ) {
    // `${code}: ${detail}`, as CostingError and PostingError both do: the message is what a direct caller
    // and a test match on, and the route layer reads `code`/`detail` separately either way.
    super(`${code}: ${detail}`);
    this.name = "LandedCostError";
  }
}

/**
 * A FIXED-scale decimal string to the exact bigint of its minor units. `Money.toString()` is always 4 dp and
 * `Quantity.toString()` always 6, so removing the point is exact — no Decimal arithmetic and nothing to round.
 */
function minorUnits(fixed: string): bigint {
  const negative = fixed.startsWith("-");
  const digits = (negative ? fixed.slice(1) : fixed).replace(".", "");
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

function weightOf(method: LandedCostMethod, t: AllocationTarget): bigint {
  switch (method) {
    case "by_value":
      return minorUnits(t.amount.toString());
    case "by_quantity":
      if (t.quantity === null) {
        throw new LandedCostError(
          "ERR_VALIDATION_FAILED",
          `line ${t.lineId} carries no quantity; by_quantity cannot weight it`,
        );
      }
      return minorUnits(t.quantity.toString());
    case "by_weight":
      if (t.weightKg === null) {
        throw new LandedCostError(
          "ERR_VALIDATION_FAILED",
          `line ${t.lineId} carries no weight_kg custom field; by_weight cannot weight it`,
        );
      }
      return minorUnits(t.weightKg.toString());
  }
}

/**
 * PURE. Splits one cost line's amount across the goods lines. `Money.allocate` guarantees Σ shares =
 * `costAmount` to the cent with the largest-remainder residue on the FIRST weight (§4.2.1) — the whole reason
 * this is not a division and a fudge, which is how a shipment's freight comes to differ from the sum of its
 * shares (spec:1020: "otherwise every margin figure is wrong").
 */
export function allocateLandedCost(input: {
  costLineId: string;
  costAmount: Money;
  method: LandedCostMethod;
  targets: readonly AllocationTarget[];
}): AllocationShare[] {
  const { costLineId, costAmount, method, targets } = input;
  if (targets.length === 0) {
    throw new LandedCostError(
      "ERR_VALIDATION_FAILED",
      `cost line ${costLineId} has no goods line to allocate onto`,
    );
  }
  const weights = targets.map((t) => weightOf(method, t));
  if (weights.some((w) => w < 0n)) {
    throw new LandedCostError(
      "ERR_VALIDATION_FAILED",
      `cost line ${costLineId}: a negative ${method} basis cannot weight an allocation`,
    );
  }
  if (weights.every((w) => w === 0n)) {
    // An all-free-of-charge shipment by value, or an unweighed one by weight. Refused by name rather than
    // divided by zero or silently spread evenly — the operator picks another method or prices the lines.
    throw new LandedCostError(
      "ERR_VALIDATION_FAILED",
      `cost line ${costLineId}: every ${method} basis is zero — choose another method or price the lines`,
    );
  }
  const shares = costAmount.allocate(weights, "HALF_AWAY_FROM_ZERO");
  return targets.map((t, i) => ({
    costLineId,
    targetLineId: t.lineId,
    method,
    amount: shares[i]!,
    weight: weights[i]!,
  }));
}

function weightKgOf(customFields: Record<string, unknown>): Quantity | null {
  const raw = customFields["weight_kg"];
  return typeof raw === "string" ? Quantity.of(raw) : null;
}

/**
 * Computes and UPSERTS every (cost line × goods line) pair, zero shares included, then returns the document's
 * rows. Draft-only and same-document are migration 0038's trigger, not this function's — so a job, a direct
 * `app_rw` statement and this call are bound by the same two rules (spec:2173).
 */
export async function allocateLandedCostForDocument(
  tx: Sql,
  ctx: TenantContext,
  input: AllocateLandedCostInput,
): Promise<LandedCostRow[]> {
  const [header] = await tx<{ company_id: string; currency: string }[]>`
    select company_id::text as company_id, currency from app.document where id = ${input.documentId}`;
  if (!header) {
    throw new LandedCostError("ERR_NOT_FOUND", `document ${input.documentId} is not visible`);
  }
  const docCurrency: CurrencyCode = currency(header.currency);

  const lines = await tx<
    {
      id: string;
      kind: string;
      amount: string;
      quantity: string | null;
      custom_fields: Record<string, unknown>;
    }[]
  >`
    select id::text as id, kind, amount::text as amount, quantity::text as quantity, custom_fields
      from app.document_line where document_id = ${input.documentId} order by line_no`;

  const targets: AllocationTarget[] = lines
    .filter((l) => l.kind === "item")
    .map((l) => ({
      lineId: l.id,
      amount: Money.of(l.amount, docCurrency),
      quantity: l.quantity === null ? null : Quantity.of(l.quantity),
      weightKg: weightKgOf(l.custom_fields),
    }));

  const shares: AllocationShare[] = [];
  for (const a of input.allocations) {
    const costLine = lines.find((l) => l.id === a.costLineId);
    if (!costLine) {
      throw new LandedCostError(
        "ERR_VALIDATION_FAILED",
        `line ${a.costLineId} is not a line of document ${input.documentId}`,
      );
    }
    if (costLine.kind !== "account") {
      throw new LandedCostError(
        "ERR_VALIDATION_FAILED",
        `line ${a.costLineId} is a ${costLine.kind} line; a landed-cost line is an account line carrying the freight, duty or clearance amount`,
      );
    }
    shares.push(
      ...allocateLandedCost({
        costLineId: a.costLineId,
        costAmount: Money.of(costLine.amount, docCurrency),
        method: a.method,
        targets,
      }),
    );
  }

  for (const share of shares) {
    // `on conflict` is the ONLY replacement mechanism: app_rw holds no DELETE (§3.5.4) and every pair is
    // written on every call, so re-allocating by another method cannot leave a stale share behind (SAH-049).
    await tx`
      insert into app.landed_cost_allocation
        (tenant_id, company_id, shipment_document_id, cost_line_id, target_line_id, method, allocated_amount)
      values (${ctx.tenantId}, ${header.company_id}, ${input.documentId}, ${share.costLineId},
              ${share.targetLineId}, ${share.method}, ${share.amount.toString()})
      on conflict (cost_line_id, target_line_id) do update
        set method = excluded.method, allocated_amount = excluded.allocated_amount`;
  }
  return listLandedCost(tx, input.documentId);
}

export async function listLandedCost(tx: Sql, documentId: string): Promise<LandedCostRow[]> {
  const rows = await tx<
    {
      id: string;
      cost_line_id: string;
      target_line_id: string;
      method: string;
      allocated_amount: string;
      // `created_at` is UNCAST, so postgres.js hands back a `Date`. `created_at::text` would be
      // `2026-01-15 10:00:00+00` — a space, not a `T` — which `TimestampSchema` (§4.2.8) rejects, and
      // `DocumentLinkRow` two tasks earlier reads the same column the same way, on purpose.
      created_at: Date;
    }[]
  >`
    select id::text as id, cost_line_id::text as cost_line_id, target_line_id::text as target_line_id,
           method, allocated_amount::text as allocated_amount, created_at
      from app.landed_cost_allocation
     where shipment_document_id = ${documentId}
     order by cost_line_id, target_line_id`;
  return rows.map((r) => ({
    id: r.id,
    costLineId: r.cost_line_id,
    targetLineId: r.target_line_id,
    method: r.method as LandedCostMethod,
    allocatedAmount: r.allocated_amount,
    createdAt: r.created_at.toISOString(),
  }));
}

export interface LandedCostSummaryRow {
  targetLineId: string;
  lineNo: number;
  itemId: string | null;
  lineAmount: string;
  allocated: string;
  landedAmount: string;
  quantity: string | null;
}

/**
 * Per goods line: the amount, the total allocated onto it, and their sum. A READ MODEL — `landedAmount` is
 * recomputed here on every read and stored nowhere (SAH-018), and the arithmetic is `Money`, never a
 * hand-rolled integer (Global Constraint 4). Task 9's two routes return it as `summary`.
 */
export async function landedCostSummary(
  tx: Sql,
  documentId: string,
): Promise<LandedCostSummaryRow[]> {
  const [header] = await tx<{ currency: string }[]>`
    select currency from app.document where id = ${documentId}`;
  if (!header) {
    throw new LandedCostError("ERR_NOT_FOUND", `document ${documentId} is not visible`);
  }
  const docCurrency: CurrencyCode = currency(header.currency);
  const allocated = await landedCostByLine(tx, documentId);
  const lines = await tx<
    {
      id: string;
      line_no: number;
      item_id: string | null;
      amount: string;
      quantity: string | null;
    }[]
  >`
    select id::text as id, line_no, item_id::text as item_id, amount::text as amount, quantity::text as quantity
      from app.document_line where document_id = ${documentId} and kind = 'item' order by line_no`;
  return lines.map((l) => {
    const share = allocated.get(l.id);
    const shareMoney = share === undefined ? Money.zero(docCurrency) : Money.of(share, docCurrency);
    const lineAmount = Money.of(l.amount, docCurrency);
    return {
      targetLineId: l.id,
      lineNo: l.line_no,
      itemId: l.item_id,
      lineAmount: lineAmount.toString(),
      allocated: shareMoney.toString(),
      landedAmount: lineAmount.add(shareMoney).toString(),
      quantity: l.quantity,
    };
  });
}

/**
 * `document_line.id` to the total allocated onto it, a DOCUMENT-currency decimal string. Empty for a document
 * with no allocation, which is the ordinary goods-receipt case; `applyMovements` then values the receipt at
 * `toBase(line.amount, rate)`.
 */
export async function landedCostByLine(tx: Sql, documentId: string): Promise<Map<string, string>> {
  const rows = await tx<{ target_line_id: string; total: string }[]>`
    select target_line_id::text as target_line_id, sum(allocated_amount)::text as total
      from app.landed_cost_allocation
     where shipment_document_id = ${documentId}
     group by target_line_id`;
  return new Map(rows.map((r) => [r.target_line_id, r.total]));
}

/**
 * The ONE rule for a purchase-side receipt movement's value (§4.7.2 branch 3, 3C). `line.amount` and not
 * `round(unit_price × quantity, 4)`: §4.3.4 defines `amount` as excl. tax in document currency, which is the
 * discount-correct figure — 3A's provisional rule ignored `document_line.discount`. One `toBase` at the end,
 * HALF_AWAY_FROM_ZERO at scale 4, which is what `ledger_entry`'s CHECK requires (hazard 23).
 */
export function receiptValue(line: LineSnapshot, landedCost: Money, rate: ExchangeRate): Money {
  return toBase(line.amount.add(landedCost), rate);
}

/**
 * INV-03 (ADR 0041, 2026-11-15 amendment). Σ `allocated_amount` per COST line, in document currency, counting
 * only shares onto `targetLineIds` — the goods lines that plan a receipt movement, which are the only lines
 * `applyMovements` reads a share for. A cost line with no share is absent from the map. Read at post, after
 * every line edit, so an allocation that `PUT …/lines` cascaded away or a cost line re-priced after its
 * allocation is seen as it stands now.
 */
export async function allocatedByCostLine(
  tx: Sql,
  documentId: string,
  targetLineIds: readonly string[],
): Promise<Map<string, string>> {
  if (targetLineIds.length === 0) return new Map();
  const rows = await tx<{ cost_line_id: string; total: string }[]>`
    select cost_line_id::text as cost_line_id, sum(allocated_amount)::text as total
      from app.landed_cost_allocation
     where shipment_document_id = ${documentId}
       and target_line_id = any(${targetLineIds as string[]}::uuid[])
     group by cost_line_id`;
  return new Map(rows.map((r) => [r.cost_line_id, r.total]));
}
