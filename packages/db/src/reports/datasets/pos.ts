import type { Sql } from "postgres";
import { defineDataset, type Dataset, type DatasetColumn } from "../query";
import type { SqlFragment } from "../sql-fragment";

/**
 * The three Phase 6 datasets (§4.16.2; contracts round 15, 7C amendment A1). 7A could not ship them:
 * `app.needs_attention` arrives with 6A's migration 0060 and `app.shift` / `app.till_event` with 6D's 0070, all
 * past the ≤ 0058 bound its registry was cut at. Same rules as `accounting.ts`: every `ref` is a literal tagged
 * template, dates and timestamps leave SQL as strings, numerics stay postgres.js strings, and the only value a
 * file here interpolates is the bound company id.
 *
 * **Every measure is a lateral in SQL**, exactly as 7A's `document.base_total` is — never JavaScript arithmetic
 * over a page, so no `number` ever holds money. The ticket predicates are 6D's `zReport` ones (a shift's
 * `POS_TICKET` documents that are posted or reversed; a return is a ticket with a negative item quantity), so a
 * definition over this dataset counts what the Z-report counts.
 *
 * **The two date companions bucket in the company's timezone** (`shift.opened_on`, `needs_attention.created_on`;
 * A16 item 3): 6D's `zReport` history and `salesByCashier` compare `date(… at time zone company.timezone)`, so a
 * `fromDate`/`toDate` over these fields selects the shifts 6D's functions select. Every timestamp stays RFC 3339
 * UTC (7B amendment A3). A `date` parameter cannot filter a `timestamp` column (7A's `assertValue`), which is
 * why the companion exists at all. A range filter on either compiles to bounds on the instant
 * (`localDateOf`), so `shift (company_id, opened_at)` and `needs_attention (company_id, created_at)` seek it.
 *
 * **Branch isolation is RLS's.** All three tables carry Form A's restrictive `branch_isolation` (0068, 0070), so
 * a branch-restricted reader sees only its branches here with no predicate of ours.
 */

/** The run's company timezone, for the two date companions' sargable bounds (`DatasetColumn.localDateOf`): a
 *  scalar subquery `localTimezoneFor` reads once before the statement, so the bound on `opened_at` / `created_at`
 *  carries the zone as a bound value and the `(company_id, …)` indexes of migration 0077 seek on it. It is the
 *  same row `co` joins. */
const companyTimezone = (tx: Sql, companyId: string): SqlFragment =>
  tx`(select tzc.timezone from app.company tzc where tzc.id = ${companyId}::uuid)`;

// ── shift — one row per till session, with the Z-report's counts and takings as laterals ────────────────
const SHIFT_COLUMNS: readonly DatasetColumn[] = [
  { field: "shift_id", kind: "uuid", ref: (tx) => tx`s.id` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`s.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`s.terminal_id` },
  { field: "terminal_code", kind: "text", ref: (tx) => tx`pt.code` },
  // ATTRIBUTION, never `*_by` (§3.3, §4.6.5): the cashier who opened the shift, not the terminal that synced it.
  { field: "cashier_principal_id", kind: "uuid", ref: (tx) => tx`s.opened_principal_id` },
  { field: "cashier_name", kind: "text", ref: (tx) => tx`op.display_name` },
  { field: "opened_at", kind: "timestamp", ref: (tx) => tx`s.opened_at` },
  {
    field: "opened_on",
    kind: "date",
    ref: (tx) => tx`(s.opened_at at time zone co.timezone)::date`,
    localDateOf: { instant: (tx) => tx`s.opened_at`, timezone: companyTimezone },
  },
  { field: "closed_at", kind: "timestamp", ref: (tx) => tx`s.closed_at` },
  { field: "closed_principal_id", kind: "uuid", ref: (tx) => tx`s.closed_principal_id` },
  { field: "currency", kind: "text", ref: (tx) => tx`s.currency` },
  { field: "opening_float", kind: "numeric", ref: (tx) => tx`s.opening_float` },
  { field: "counted_cash", kind: "numeric", ref: (tx) => tx`s.counted_cash` },
  { field: "expected_cash", kind: "numeric", ref: (tx) => tx`s.expected_cash` },
  // POSITIVE IS OVER (§4.6.5, 0070's CHECK `over_short = counted_cash - expected_cash`); never re-signed here.
  { field: "over_short", kind: "numeric", ref: (tx) => tx`s.over_short` },
  { field: "over_short_document_id", kind: "uuid", ref: (tx) => tx`s.over_short_document_id` },
  { field: "ticket_count", kind: "integer", ref: (tx) => tx`tk.ticket_count` },
  { field: "return_count", kind: "integer", ref: (tx) => tx`tk.return_count` },
  { field: "net_sales_base", kind: "numeric", ref: (tx) => tx`ns.net_sales_base` },
  { field: "no_sale_count", kind: "integer", ref: (tx) => tx`ev.no_sale_count` },
  { field: "drawer_open_count", kind: "integer", ref: (tx) => tx`ev.drawer_open_count` },
  { field: "void_count", kind: "integer", ref: (tx) => tx`ev.void_count` },
];

export const shiftDataset: Dataset = defineDataset({
  id: "shift",
  columns: SHIFT_COLUMNS,
  company: (tx, companyId) => tx`s.company_id = ${companyId}::uuid`,
  // `a4.type`, NOT `a4.account_type`: `app.account` declares `type app.account_type`, and `account_type` is the
  // ENUM's name. 6D's `salesByCashier` carries the same note. `net_sales_base` is Σ(base_credit − base_debit)
  // over INCOME accounts — the measure `SalesByCashierRow.netSalesBase` names, so a parity case compares like
  // with like. There is deliberately no discount or cash-rounding figure: 6D derives both from
  // `document_line.custom_fields` (ADR 0059) and a second derivation would be two definitions of one number.
  from: (tx) => tx`app.shift s
        join app.company         co on co.id = s.company_id
        join app.dimension_value bv on bv.id = s.branch_id
        join app.pos_terminal    pt on pt.id = s.terminal_id
        join app.principal       op on op.id = s.opened_principal_id
        cross join lateral (
          select (count(*) filter (where not k.is_return))::int as ticket_count,
                 (count(*) filter (where k.is_return))::int     as return_count
            from (select exists (select 1 from app.document_line l
                                  where l.document_id = d3.id and l.kind = 'item' and l.quantity < 0) as is_return
                    from app.document d3
                    join app.document_type t3 on t3.id = d3.document_type_id
                   where d3.shift_id = s.id and t3.code = 'POS_TICKET'
                     and d3.status in ('posted', 'reversed')) k
        ) tk
        cross join lateral (
          select coalesce(sum(le.base_credit - le.base_debit), 0)::numeric(19,4) as net_sales_base
            from app.document d4
            join app.document_type t4 on t4.id = d4.document_type_id
            join app.ledger_entry  le on le.document_id = d4.id
            join app.account       a4 on a4.id = le.account_id and a4.type = 'income'
           where d4.shift_id = s.id and t4.code = 'POS_TICKET' and d4.status in ('posted', 'reversed')
        ) ns
        cross join lateral (
          select (count(*) filter (where te.kind = 'no_sale'))::int     as no_sale_count,
                 (count(*) filter (where te.kind = 'drawer_open'))::int as drawer_open_count,
                 (count(*) filter (where te.kind = 'void'))::int        as void_count
            from app.till_event te
           where te.shift_id = s.id
        ) ev`,
  select: (tx) => tx`s.id as shift_id, s.branch_id as branch_id, bv.code as branch_code,
         s.terminal_id as terminal_id, pt.code as terminal_code,
         s.opened_principal_id as cashier_principal_id, op.display_name as cashier_name,
         to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as opened_at,
         to_char((s.opened_at at time zone co.timezone)::date, 'YYYY-MM-DD') as opened_on,
         to_char(s.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as closed_at,
         s.closed_principal_id as closed_principal_id, s.currency::text as currency,
         s.opening_float as opening_float, s.counted_cash as counted_cash,
         s.expected_cash as expected_cash, s.over_short as over_short,
         s.over_short_document_id as over_short_document_id,
         tk.ticket_count as ticket_count, tk.return_count as return_count,
         ns.net_sales_base as net_sales_base,
         ev.no_sale_count as no_sale_count, ev.drawer_open_count as drawer_open_count,
         ev.void_count as void_count`,
  defaultOrder: (tx) => tx`s.opened_at desc, s.id desc`,
});

// ── till_event — the drawer and void events on the ticket stream (spec:1354); read by no core definition ──
// Registered for the report designer (amendment A2): a drawer-open audit is a tenant's own definition. No
// `client_ref`: the till's uuid is an idempotency key, not a reporting fact.
const TILL_EVENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "till_event_id", kind: "uuid", ref: (tx) => tx`te.id` },
  { field: "shift_id", kind: "uuid", ref: (tx) => tx`te.shift_id` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`te.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`te.terminal_id` },
  { field: "terminal_code", kind: "text", ref: (tx) => tx`pt.code` },
  // 0070's CHECK: no_sale | drawer_open | void.
  { field: "kind", kind: "text", ref: (tx) => tx`te.kind` },
  { field: "ticket_document_id", kind: "uuid", ref: (tx) => tx`te.ticket_document_id` },
  { field: "ticket_number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "cashier_principal_id", kind: "uuid", ref: (tx) => tx`te.cashier_principal_id` },
  { field: "cashier_name", kind: "text", ref: (tx) => tx`cp.display_name` },
  { field: "supervisor_principal_id", kind: "uuid", ref: (tx) => tx`te.supervisor_principal_id` },
  { field: "reason", kind: "text", ref: (tx) => tx`te.reason` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`te.occurred_at` },
];

export const tillEventDataset: Dataset = defineDataset({
  id: "till_event",
  columns: TILL_EVENT_COLUMNS,
  company: (tx, companyId) => tx`te.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.till_event te
        join app.dimension_value bv on bv.id = te.branch_id
        join app.pos_terminal    pt on pt.id = te.terminal_id
        join app.principal       cp on cp.id = te.cashier_principal_id
        left join app.document   d  on d.id  = te.ticket_document_id`,
  select: (tx) => tx`te.id as till_event_id, te.shift_id as shift_id, te.branch_id as branch_id,
         bv.code as branch_code, te.terminal_id as terminal_id, pt.code as terminal_code, te.kind as kind,
         te.ticket_document_id as ticket_document_id, d.number::int as ticket_number,
         te.cashier_principal_id as cashier_principal_id, cp.display_name as cashier_name,
         te.supervisor_principal_id as supervisor_principal_id, te.reason as reason,
         to_char(te.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at`,
  defaultOrder: (tx) => tx`te.occurred_at desc, te.id desc`,
});

// ── needs_attention — every ticket the sync apply refused (spec:1305) ──────────────────────────────────
const NEEDS_ATTENTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "needs_attention_id", kind: "uuid", ref: (tx) => tx`na.id` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`na.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "terminal_id", kind: "uuid", ref: (tx) => tx`na.terminal_id` },
  { field: "terminal_code", kind: "text", ref: (tx) => tx`pt.code` },
  // The column a resolver needs: the ticket is found at the till by this ref.
  { field: "client_ref", kind: "uuid", ref: (tx) => tx`na.client_ref` },
  { field: "error_code", kind: "text", ref: (tx) => tx`na.error_code` },
  { field: "error_detail", kind: "text", ref: (tx) => tx`na.error_detail` },
  // The table's server-stamped `resolved_by`, renamed: a dataset FIELD named `*_by` invites a report to read it
  // as attribution (§3.3).
  { field: "resolved_principal_id", kind: "uuid", ref: (tx) => tx`na.resolved_by` },
  { field: "resolved_at", kind: "timestamp", ref: (tx) => tx`na.resolved_at` },
  { field: "resolution_note", kind: "text", ref: (tx) => tx`na.resolution_note` },
  { field: "created_at", kind: "timestamp", ref: (tx) => tx`na.created_at` },
  {
    field: "created_on",
    kind: "date",
    ref: (tx) => tx`(na.created_at at time zone co.timezone)::date`,
    localDateOf: { instant: (tx) => tx`na.created_at`, timezone: companyTimezone },
  },
  { field: "is_open", kind: "boolean", ref: (tx) => tx`(na.resolved_at is null)` },
];

export const needsAttentionDataset: Dataset = defineDataset({
  id: "needs_attention",
  columns: NEEDS_ATTENTION_COLUMNS,
  company: (tx, companyId) => tx`na.company_id = ${companyId}::uuid`,
  // The rejected ticket's body is NEVER selected (amendment A1): it is the whole ticket — items, prices, the
  // customer, the cashier's overrides — and a report column would be a covered side channel of exactly the kind
  // spec:2450 and spec:2454 close. It stays reachable through 6A's gated needs-attention resource. A ticket
  // refused before its terminal resolved has no terminal, so that join is a left join.
  from: (tx) => tx`app.needs_attention na
        join app.company           co on co.id = na.company_id
        join app.dimension_value   bv on bv.id = na.branch_id
        left join app.pos_terminal pt on pt.id = na.terminal_id`,
  select: (tx) => tx`na.id as needs_attention_id, na.branch_id as branch_id, bv.code as branch_code,
         na.terminal_id as terminal_id, pt.code as terminal_code, na.client_ref as client_ref,
         na.error_code as error_code, na.error_detail as error_detail,
         na.resolved_by as resolved_principal_id,
         to_char(na.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as resolved_at,
         na.resolution_note as resolution_note,
         to_char(na.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
         to_char((na.created_at at time zone co.timezone)::date, 'YYYY-MM-DD') as created_on,
         (na.resolved_at is null) as is_open`,
  defaultOrder: (tx) => tx`na.created_at desc, na.id desc`,
});
