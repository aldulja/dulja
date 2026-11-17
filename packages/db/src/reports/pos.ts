import { Money, currency } from "@dulja/domain";
import type { Sql } from "postgres";
import { CASH_ROUNDING_FIELD } from "../sync/cash-rounding";
import { PROMOTION_FIELD } from "../sync/promotion";

/** 4B's `BankMatchError` shape: exported so `apps/api` can `instanceof` it, `code` a literal member of
 *  `ErrCode` so the handler needs no branch, the token in the message so db-tier tests match on it. */
export class ReportParamError extends Error {
  readonly code = "ERR_VALIDATION_FAILED" as const;
  constructor(readonly detail: string) {
    super(`ERR_VALIDATION_FAILED: ${detail}`);
  }
}

export interface ZReportParams {
  companyId: string;
  /** One shift → exactly one Z-report. */
  shiftId?: string;
  /** A range → the shift HISTORY §4.16.1 names, under the SAME code. That is why both return an array. */
  branchId?: string;
  from?: string;
  to?: string;
  limit: number;
  /** The last row's own `openedAt` and `shiftId`, fed back as they were returned: `openedAt` is exact to the
   *  microsecond (see `ZReport.openedAt`), so the next page starts exactly after that row. */
  cursor?: { openedAt: string; shiftId: string } | null;
}

export interface ZReportTender {
  method: string;
  accountCode: string;
  amount: string;
  currency: string;
}

/** One cash-control movement on `1110` that is **not** a ticket tender, per document type. There is no
 *  `kind` member: an earlier draft carried `kind: string` always filled with the literal `"cash_control"`,
 *  which the wire schema (`ZReportCashLineSchema`) then dropped — a field that conveys nothing and that a
 *  7C re-expression would have to keep in step for no reason. The section it appears in *is* the kind. */
export interface ZReportCashLine {
  documentTypeCode: string;
  amount: string;
  currency: string;
}

export interface ZReport {
  shiftId: string;
  branchId: string;
  terminalId: string;
  terminalCode: string;
  /** ISO 8601 in UTC at the MICROSECOND — `app.shift.opened_at` exactly, because it is the history's keyset
   *  key. A shift a till syncs opens at a whole millisecond (the sync path binds `at` through a JS `Date`),
   *  but a row whose instant SQL wrote (`now()`) holds microseconds, and a copy cut to the millisecond, fed
   *  back as `cursor.openedAt`, would land before that row: the next page would skip every shift opened
   *  earlier within the same millisecond. The wire DTO shows milliseconds. */
  openedAt: string;
  closedAt: string | null;
  openedPrincipalId: string;
  closedPrincipalId: string | null;
  currency: string;
  openingFloat: string;
  countedCash: string | null;
  expectedCash: string | null;
  overShort: string | null;
  overShortDocumentId: string | null;
  ticketCount: number;
  returnCount: number;
  tenders: ZReportTender[];
  cashControl: ZReportCashLine[];
  tillEvents: { kind: string; count: number }[];
}

export interface SalesByCashierParams {
  companyId: string;
  from: string;
  to: string;
  branchId?: string;
  cashierPrincipalId?: string;
  limit: number;
  cursor?: { cashierPrincipalId: string; branchId: string } | null;
}

export interface SalesByCashierRow {
  cashierPrincipalId: string;
  cashierName: string;
  branchId: string;
  ticketCount: number;
  returnCount: number;
  netSalesBase: string;
  baseCurrency: string;
  /** Manual discounts only: the posted line discounts less the cash rounding they absorbed and the verified
   *  promotion shares they carry (ADR 0059 and its PR 12 review amendment). */
  discountBase: string;
  /** The automatic cash rounding, signed as rounded payable − original gross: positive when rounding raised
   *  the takings (a sale rounded up), negative when it lowered them (a sale rounded down, a refund whose
   *  payout was rounded up). A refund gives back its sale's share, so a fully refunded sale nets to zero. */
  cashRoundingBase: string;
  overShortBase: string;
}

/** The §4.6.5 tender-method → §4.15 account-code map, in the ONE place a report may hold it. It mirrors
 *  the four `when: { line.tender_method }` rules of 6A's POS_TICKET policy; a fifth method would be a
 *  §4.6.5 amendment and a policy rule, and this map would grow in the same PR. */
const TENDER_ACCOUNT: Readonly<Record<string, string>> = {
  cash: "1110",
  card: "1120",
  transfer: "1100",
  store_credit: "2200",
};

/**
 * `pos.z_report` — ONE code, TWO parameter shapes (§4.16.1, amendment A5).
 *
 * `shiftId` returns exactly one report; `from`/`to` return the shift history, newest first, keyset-paged
 * on `(opened_at desc, id desc)` over `shift_branch_opened_idx` (0070). Both return an array, which is why
 * 7C can re-express the code as one `ReportDefinition` with an optional parameter rather than two.
 *
 * **Every figure comes from `app.ledger_entry`, never from `document_line`.** The DoD sentence is "the
 * shift Z-report ties to the ledger to the cent", and a report that summed tender lines would be a second
 * computation that can disagree — which is the defect LEGACY-055 names ("a figure recomputed by a staler
 * rule") and the reason 1B's `trialBalance` reads `account_balance` rather than re-aggregating.
 *
 * **Branch isolation is RLS's job; the report code is this query's.** `app.shift` carries Form A's
 * restrictive `branch_isolation` policy (0070), so a branch manager at B reads zero rows here with no
 * `WHERE` clause of ours — which is what makes the isolation hold "through any endpoint, filter or export"
 * (spec:2454). But that policy admits a branch where the caller holds ANY role, so every shift is also
 * filtered by `app.actor_has('pos.report.read', …)` at its own branch (R7): a cashier role at B, or a
 * company-wide role without the code, must not read B's float, count and over/short. Every figure below
 * hangs off the shift ids this read returns, so the one predicate bounds the whole report.
 */
export async function zReport(tx: Sql, params: ZReportParams): Promise<ZReport[]> {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 1001)
    throw new ReportParamError("report limit must be between 1 and 1001");
  if (params.from && params.to && params.from > params.to)
    throw new ReportParamError("report from must not follow to");
  const oneShift = params.shiftId !== undefined && params.shiftId !== null;
  const aRange = params.from !== undefined && params.to !== undefined;
  if (!oneShift && !aRange) {
    throw new ReportParamError(
      "pos.z_report needs either shiftId (one Z-report) or from and to (the shift history)",
    );
  }

  const shifts = await tx<
    {
      id: string;
      branch_id: string;
      terminal_id: string;
      terminal_code: string;
      opened_at: string;
      closed_at: string | null;
      opened_principal_id: string;
      closed_principal_id: string | null;
      currency: string;
      opening_float: string;
      counted_cash: string | null;
      expected_cash: string | null;
      over_short: string | null;
      over_short_document_id: string | null;
    }[]
  >`
    select s.id::text, s.branch_id::text, s.terminal_id::text, pt.code as terminal_code,
           to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as opened_at,
           s.closed_at::text,
           s.opened_principal_id::text, s.closed_principal_id::text, s.currency,
           s.opening_float::text, s.counted_cash::text, s.expected_cash::text,
           s.over_short::text, s.over_short_document_id::text
      from app.shift s
      join app.pos_terminal pt on pt.id = s.terminal_id
      join app.company company on company.id=s.company_id
     where s.company_id = ${params.companyId}
       and app.actor_has('pos.report.read', s.company_id, s.branch_id)
       and (${params.shiftId ?? null}::uuid is null or s.id = ${params.shiftId ?? null}::uuid)
       and (${params.branchId ?? null}::uuid is null or s.branch_id = ${params.branchId ?? null}::uuid)
       and (${params.from ?? null}::date is null or date(s.opened_at at time zone company.timezone) >= ${params.from ?? null}::date)
       and (${params.to ?? null}::date is null or date(s.opened_at at time zone company.timezone) <= ${params.to ?? null}::date)
       -- ::text::timestamptz, never ::timestamptz alone: a parameter typed timestamptz is serialised by
       -- postgres.js through a JS Date, which drops the microseconds the cursor carries.
       and (${params.cursor?.openedAt ?? null}::text is null
            or (s.opened_at, s.id) < (${params.cursor?.openedAt ?? null}::text::timestamptz,
                                      ${params.cursor?.shiftId ?? null}::uuid))
     order by s.opened_at desc, s.id desc
     limit ${params.limit}`;
  if (shifts.length === 0) return [];

  const ids = shifts.map((s) => s.id);

  // Tenders: the ledger movement on the four §4.15 tender accounts, over POS_TICKET documents ONLY.
  // **Scoped to POS_TICKET deliberately.** OD-10's TILL_BANKING (ADR 0064) debits 1100, which is the `transfer`
  // tender's account — without this predicate a day's banking would appear as a transfer sale, and the
  // "tenders by type" line would be wrong in exactly the way a shop would notice and not be able to
  // explain. Cash control gets its own section below.
  const tenders = await tx<
    {
      shift_id: string;
      code: string;
      movement: string;
      currency: string;
    }[]
  >`
    select d.shift_id::text, a.code, (sum(le.debit) - sum(le.credit))::text as movement, le.currency
      from app.ledger_entry le
      join app.document      d on d.id = le.document_id
      join app.document_type t on t.id = d.document_type_id
      join app.account       a on a.id = le.account_id
     where d.shift_id = any(${ids}::uuid[])
       and d.status in ('posted', 'reversed')
       and t.code = 'POS_TICKET'
       and a.code = any(${Object.values(TENDER_ACCOUNT)}::text[])
     group by d.shift_id, a.code, le.currency
    having sum(le.debit) - sum(le.credit) <> 0
     order by a.code`;

  // Cash control: every OTHER movement on 1110, one row per document type. TILL_OVER_SHORT is here and
  // not in `tenders`, and so are OD-10's paid-outs, safe drops and drawer bankings (ADR 0064), with no
  // change to this query; a banking from the safe never touches 1110 and is not listed.
  const control = await tx<
    {
      shift_id: string;
      type_code: string;
      movement: string;
      currency: string;
    }[]
  >`
    select d.shift_id::text, t.code as type_code, (sum(le.debit) - sum(le.credit))::text as movement,
           le.currency
      from app.ledger_entry le
      join app.document      d on d.id = le.document_id
      join app.document_type t on t.id = d.document_type_id
      join app.account       a on a.id = le.account_id
     where d.shift_id = any(${ids}::uuid[])
       and d.status in ('posted', 'reversed')
       and t.code <> 'POS_TICKET'
       and a.code = '1110'
     group by d.shift_id, t.code, le.currency
    having sum(le.debit) - sum(le.credit) <> 0
     order by t.code`;

  const counts = await tx<{ shift_id: string; kind: string; n: number }[]>`
    select d.shift_id::text,
           case when exists (select 1 from app.document_line l
                              where l.document_id = d.id and l.kind = 'item' and l.quantity < 0)
                then 'return' else 'ticket' end as kind,
           count(*)::int as n
      from app.document d
      join app.document_type t on t.id = d.document_type_id
     where d.shift_id = any(${ids}::uuid[]) and t.code = 'POS_TICKET' and d.status in ('posted', 'reversed')
     group by d.shift_id, 2`;

  const events = await tx<{ shift_id: string; kind: string; n: number }[]>`
    select shift_id::text, kind, count(*)::int as n from app.till_event
     where shift_id = any(${ids}::uuid[]) group by shift_id, kind order by kind`;

  const ACCOUNT_TENDER = Object.fromEntries(Object.entries(TENDER_ACCOUNT).map(([m, c]) => [c, m]));
  return shifts.map((s) => ({
    shiftId: s.id,
    branchId: s.branch_id,
    terminalId: s.terminal_id,
    terminalCode: s.terminal_code,
    openedAt: s.opened_at,
    closedAt: s.closed_at === null ? null : new Date(s.closed_at).toISOString(),
    openedPrincipalId: s.opened_principal_id,
    closedPrincipalId: s.closed_principal_id,
    currency: s.currency,
    openingFloat: s.opening_float,
    countedCash: s.counted_cash,
    expectedCash: s.expected_cash,
    overShort: s.over_short,
    overShortDocumentId: s.over_short_document_id,
    ticketCount: counts.find((c) => c.shift_id === s.id && c.kind === "ticket")?.n ?? 0,
    returnCount: counts.find((c) => c.shift_id === s.id && c.kind === "return")?.n ?? 0,
    tenders: tenders
      .filter((t) => t.shift_id === s.id)
      .map((t) => ({
        method: ACCOUNT_TENDER[t.code]!,
        accountCode: t.code,
        amount: t.movement,
        currency: t.currency,
      })),
    cashControl: control
      .filter((c) => c.shift_id === s.id)
      .map((c) => ({
        documentTypeCode: c.type_code,
        amount: c.movement,
        currency: c.currency,
      })),
    tillEvents: events
      .filter((e) => e.shift_id === s.id)
      .map((e) => ({ kind: e.kind, count: e.n })),
  }));
}

/**
 * `pos.sales_by_cashier` — revenue per cashier, from the ledger's INCOME accounts.
 *
 * Grouped by `document.attributed_to`, which is the cashier (hazard 19): `posted_by` is the terminal and
 * would give one row per till. `netSalesBase` is `Σ(base_credit − base_debit)` on `account.type = 'income'`
 * — the sign convention that makes a sale positive and a refund's credit note negative, with no sign test
 * on an amount anywhere (§4.4.2 A9). Base amounts, not document amounts, because a cashier's day may hold
 * two currencies and "sales by cashier" is one figure.
 *
 * `overShortBase` is attached from `shift.over_short` by closer, so a manager reading the report sees the
 * discrepancy beside the takings of the person who declared it.
 *
 * **Cash rounding is not a discount** (ADR 0059, owner direction 2026-10-22). A rounded cash ticket absorbs
 * its adjustment into the target line's `discount` — the only way it balances with no rounding account — and
 * records that adjustment on the line under `CASH_ROUNDING_FIELD`, in the line's own direction. Each line's
 * signed adjustment is that record times the sign of its quantity, which also unwinds a reversal mirror (it
 * copies `custom_fields` and negates quantity and discount). `cashRoundingBase` sums the signed adjustments.
 *
 * **Nor is a promotion** (ADR 0059's PR 12 review amendment): it is the shop's decision, and `verifyPromotions`
 * already keeps it out of discount authority and the branch limits. A line whose promotion claim the server
 * verified records that share under `PROMOTION_FIELD`, in the same line-direction form, and a referenced refund
 * records its share of its sale line's. `discountBase` is the posted discounts plus the signed rounding less the
 * signed promotion shares, which is what the cashier actually discounted: a claim the server could not prove
 * recorded nothing, so its whole discount stays the cashier's here as it was at the limits. Both records count
 * only on a terminal's document, as `loadPosReturnHistory` trusts only those: a POS_TICKET no terminal wrote
 * cannot claim rounding or a promotion.
 *
 * Both sources — the tickets and the closed shifts — are filtered by `app.actor_has('pos.report.read', …)`
 * at each row's own branch, for `zReport`'s reason (R7): `branch_isolation` alone admits any role's branch.
 */
export async function salesByCashier(
  tx: Sql,
  params: SalesByCashierParams,
): Promise<SalesByCashierRow[]> {
  if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 1001)
    throw new ReportParamError("report limit must be between 1 and 1001");
  if (params.from > params.to) throw new ReportParamError("report from must not follow to");
  if (!params.from || !params.to) {
    throw new ReportParamError("pos.sales_by_cashier needs both from and to");
  }
  const rows = await tx<
    {
      cashier: string;
      cashier_name: string;
      branch_id: string;
      base_currency: string;
      ticket_count: number;
      return_count: number;
      net_sales: string;
      discount: string;
      cash_rounding: string;
      over_short: string;
    }[]
  >`
    with tickets as (
      select d.attributed_to, d.branch_id, d.id, d.terminal_id,
             exists (select 1 from app.document_line l
                      where l.document_id = d.id and l.kind = 'item' and l.quantity < 0) as is_return
        from app.document d
        join app.document_type t on t.id = d.document_type_id
       where d.company_id = ${params.companyId}
         and app.actor_has('pos.report.read', d.company_id, d.branch_id)
         and t.code = 'POS_TICKET'
         and d.status in ('posted', 'reversed')
         and d.effective_date between ${params.from}::date and ${params.to}::date
         and (${params.branchId ?? null}::uuid is null or d.branch_id = ${params.branchId ?? null}::uuid)
         and (${params.cashierPrincipalId ?? null}::uuid is null
              or d.attributed_to = ${params.cashierPrincipalId ?? null}::uuid)
    ),
    -- TWO CTEs and not one. Joining ledger_entry (N rows per ticket) to document_line (M rows per
    -- ticket) inside one aggregate multiplies BOTH sums by the other's cardinality: net sales would be M
    -- times too large and the discount N times too large. The defect is invisible to a test that only
    -- checks the shape of the number, which is why Step 1's seventh case compares a computed figure.
    revenue as (
      -- a.type, NOT a.account_type. app.account declares type app.account_type not null
      -- (plan0A:1492); account_type is the ENUM TYPE's name (plan0A:1484) and §3.2 forbids renames, so
      -- no migration ever adds the other spelling. a.account_type fails with
      -- column a.account_type does not exist and takes the whole report down. 1b:2779, 4b:2169 and
      -- 5a:4676 all use a.type.
      select k.attributed_to, k.branch_id, sum(le.base_credit - le.base_debit) as net
        from tickets k
        join app.ledger_entry le on le.document_id = k.id
        join app.account       a on a.id = le.account_id and a.type = 'income'
       group by k.attributed_to,k.branch_id
    ),
    discounts as (
      select k.attributed_to, k.branch_id,
             sum(l.discount + x.rounding - x.promotion) as disc, sum(x.rounding) as rounding
        from tickets k
        join app.document_line l on l.document_id = k.id and l.kind = 'item'
        cross join lateral (
          select case when k.terminal_id is null then 0
                      else coalesce((l.custom_fields ->> ${CASH_ROUNDING_FIELD}::text)::numeric, 0)
                           * case when l.quantity < 0 then -1 else 1 end
                 end as rounding,
                 case when k.terminal_id is null then 0
                      else coalesce((l.custom_fields ->> ${PROMOTION_FIELD}::text)::numeric, 0)
                           * case when l.quantity < 0 then -1 else 1 end
                 end as promotion) x
       group by k.attributed_to,k.branch_id
    ),
    shortfall as (
      select s.closed_principal_id as p, s.branch_id, sum(s.over_short) as os
        from app.shift s join app.company company on company.id=s.company_id
       where s.company_id = ${params.companyId} and s.closed_at is not null
         and app.actor_has('pos.report.read', s.company_id, s.branch_id)
         and date(s.closed_at at time zone company.timezone) between ${params.from}::date and ${params.to}::date
         and (${params.branchId ?? null}::uuid is null or s.branch_id = ${params.branchId ?? null}::uuid)
       group by s.closed_principal_id,s.branch_id
    ), actors as (
      select distinct attributed_to,branch_id from tickets
      union select p,branch_id from shortfall
    )
    select k.attributed_to::text as cashier, p.display_name as cashier_name,
           k.branch_id::text as branch_id, c.base_currency,
           count(tk.id) filter (where not tk.is_return)::int as ticket_count,
           count(tk.id) filter (where tk.is_return)::int     as return_count,
           coalesce(max(r.net), 0)::text                as net_sales,
           coalesce(max(dc.disc), 0)::text              as discount,
           coalesce(max(dc.rounding), 0)::text          as cash_rounding,
           coalesce(max(sf.os), 0)::text                as over_short
      from actors k
      left join tickets tk on tk.attributed_to=k.attributed_to and tk.branch_id=k.branch_id
      join app.principal p on p.id = k.attributed_to
      join app.company   c on c.id = ${params.companyId}
      left join revenue   r  on r.attributed_to  = k.attributed_to and r.branch_id=k.branch_id
      left join discounts dc on dc.attributed_to = k.attributed_to and dc.branch_id=k.branch_id
      left join shortfall sf on sf.p             = k.attributed_to and sf.branch_id=k.branch_id
     where (${params.cashierPrincipalId ?? null}::uuid is null or k.attributed_to=${params.cashierPrincipalId ?? null}::uuid)
       and (${params.cursor?.cashierPrincipalId ?? null}::uuid is null
            or (k.attributed_to,k.branch_id) > (${params.cursor?.cashierPrincipalId ?? null}::uuid,${params.cursor?.branchId ?? null}::uuid))
     group by k.attributed_to,k.branch_id, p.display_name, c.base_currency
     order by k.attributed_to,k.branch_id
     limit ${params.limit}`;

  return rows.map((r) => ({
    cashierPrincipalId: r.cashier,
    cashierName: r.cashier_name,
    branchId: r.branch_id,
    ticketCount: r.ticket_count,
    returnCount: r.return_count,
    netSalesBase: Money.of(r.net_sales, currency(r.base_currency)).toString(),
    baseCurrency: r.base_currency,
    discountBase: Money.of(r.discount, currency(r.base_currency)).toString(),
    cashRoundingBase: Money.of(r.cash_rounding, currency(r.base_currency)).toString(),
    overShortBase: Money.of(r.over_short, currency(r.base_currency)).toString(),
  }));
}
