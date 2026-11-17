import { defineDataset, type Dataset, type DatasetColumn } from "../query";

/**
 * Every `ref` below is a literal tagged template. A ReportDefinition contributes a `field` STRING, which is
 * looked up in the `columns` array; the fragment it maps to was authored here (test 27, LEGACY-036/037/069).
 *
 * Every `date` is emitted as `to_char(x, 'YYYY-MM-DD')` and every `timestamptz` as
 * `to_char(x at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`, so a DatasetRow value is never a JS `Date`
 * and never depends on the session's TimeZone. `numeric` comes back from postgres.js as a string, which is
 * what keeps money out of a JS number (spec:2041).
 *
 * `app.fiscal_period` has no `code` column (spec:1657-1670 gives it `starts_on`, `ends_on`, `status`,
 * `closed_by`, `closed_at` and 1A's `reopen_reason`; the 0001 table has nothing else). The period label is
 * DERIVED as `to_char(fp.starts_on, 'YYYY-MM')` — the `2026-01` spelling the 0A fixtures use — and every
 * dataset that exposes `fiscal_period_code` spells it the same way (§4.6.1 note, 7A execution handoff).
 */

/** The cost read code (3B), named once: a column carrying a cost figure declares it as `requires`. */
const COST_READ = "inventory.cost.read";
/** `column` with `requires: COST_READ` — a wrapper, so the column literal itself reads as every other does. */
const costRead = (column: DatasetColumn): DatasetColumn => ({ ...column, requires: COST_READ });
// ── ledger_entry — the immutable financial truth, joined to its document and account ────────────────
const LEDGER_ENTRY_COLUMNS: readonly DatasetColumn[] = [
  { field: "entry_id", kind: "uuid", ref: (tx) => tx`l.id` },
  { field: "account_id", kind: "uuid", ref: (tx) => tx`l.account_id` },
  { field: "account_code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "account_name_en", kind: "text", ref: (tx) => tx`ac.name_en` },
  { field: "account_name_ar", kind: "text", ref: (tx) => tx`ac.name_ar` },
  { field: "account_type", kind: "text", ref: (tx) => tx`ac.type::text` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`l.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`d.party_id` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`l.line_no` },
  { field: "currency", kind: "text", ref: (tx) => tx`l.currency` },
  { field: "exchange_rate", kind: "numeric", ref: (tx) => tx`l.exchange_rate` },
  { field: "debit", kind: "numeric", ref: (tx) => tx`l.debit` },
  { field: "credit", kind: "numeric", ref: (tx) => tx`l.credit` },
  { field: "base_debit", kind: "numeric", ref: (tx) => tx`l.base_debit` },
  { field: "base_credit", kind: "numeric", ref: (tx) => tx`l.base_credit` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`l.effective_date` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`l.fiscal_period_id` },
  // DERIVED, not stored — see the file comment. A filter on it is a text filter over the expression, which
  // is why the `ref` closure and not a bare column name is what a filter composes against.
  {
    field: "fiscal_period_code",
    kind: "text",
    ref: (tx) => tx`to_char(fp.starts_on, 'YYYY-MM')`,
  },
  { field: "posting_seq", kind: "integer", ref: (tx) => tx`d.posting_seq` },
  { field: "posted_at", kind: "timestamp", ref: (tx) => tx`l.posted_at` },
];

export const ledgerEntryDataset: Dataset = defineDataset({
  id: "ledger_entry",
  columns: LEDGER_ENTRY_COLUMNS,
  company: (tx, companyId) => tx`l.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.ledger_entry l
        join app.account         ac on ac.id = l.account_id
        join app.document        d  on d.id  = l.document_id
        join app.document_type   dt on dt.id = d.document_type_id
        join app.fiscal_period   fp on fp.id = l.fiscal_period_id
        join app.dimension_value bv on bv.id = d.branch_id`,
  select: (tx) => tx`l.id                          as entry_id,
         l.account_id                              as account_id,
         ac.code                                   as account_code,
         ac.name_en                                as account_name_en,
         ac.name_ar                                as account_name_ar,
         ac.type::text                             as account_type,
         l.document_id                             as document_id,
         dt.code                                   as document_type_code,
         d.series                                  as series,
         d.number::int                             as number,
         d.branch_id                               as branch_id,
         bv.code                                   as branch_code,
         d.party_id                                as party_id,
         l.line_no                                 as line_no,
         l.currency                                as currency,
         l.exchange_rate                           as exchange_rate,
         l.debit                                   as debit,
         l.credit                                  as credit,
         l.base_debit                              as base_debit,
         l.base_credit                             as base_credit,
         to_char(l.effective_date, 'YYYY-MM-DD')   as effective_date,
         l.fiscal_period_id                        as fiscal_period_id,
         to_char(fp.starts_on, 'YYYY-MM')          as fiscal_period_code,
         d.posting_seq::int                        as posting_seq,
         to_char(l.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at`,
  // The chronological key of §4.3.5, so a ledger read is in posting order by default.
  defaultOrder: (tx) => tx`l.effective_date asc, d.posting_seq asc, l.line_no asc`,
});

// ── account_balance — the SYNCHRONOUS projection; never a re-aggregation of ledger_entry ────────────
const ACCOUNT_BALANCE_COLUMNS: readonly DatasetColumn[] = [
  { field: "account_id", kind: "uuid", ref: (tx) => tx`b.account_id` },
  { field: "account_code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "account_name_en", kind: "text", ref: (tx) => tx`ac.name_en` },
  { field: "account_name_ar", kind: "text", ref: (tx) => tx`ac.name_ar` },
  { field: "account_type", kind: "text", ref: (tx) => tx`ac.type::text` },
  { field: "is_group", kind: "boolean", ref: (tx) => tx`ac.is_group` },
  { field: "parent_id", kind: "uuid", ref: (tx) => tx`ac.parent_id` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`b.fiscal_period_id` },
  {
    field: "fiscal_period_code",
    kind: "text",
    ref: (tx) => tx`to_char(fp.starts_on, 'YYYY-MM')`,
  },
  { field: "currency", kind: "text", ref: (tx) => tx`b.currency` },
  { field: "debit", kind: "numeric", ref: (tx) => tx`b.debit` },
  { field: "credit", kind: "numeric", ref: (tx) => tx`b.credit` },
  { field: "base_debit", kind: "numeric", ref: (tx) => tx`b.base_debit` },
  { field: "base_credit", kind: "numeric", ref: (tx) => tx`b.base_credit` },
  { field: "base_balance", kind: "numeric", ref: (tx) => tx`(b.base_debit - b.base_credit)` },
];

export const accountBalanceDataset: Dataset = defineDataset({
  id: "account_balance",
  columns: ACCOUNT_BALANCE_COLUMNS,
  company: (tx, companyId) => tx`b.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.account_balance b
        join app.account       ac on ac.id = b.account_id
        join app.fiscal_period fp on fp.id = b.fiscal_period_id`,
  select: (tx) => tx`b.account_id                  as account_id,
         ac.code                                   as account_code,
         ac.name_en                                as account_name_en,
         ac.name_ar                                as account_name_ar,
         ac.type::text                             as account_type,
         ac.is_group                               as is_group,
         ac.parent_id                              as parent_id,
         b.fiscal_period_id                        as fiscal_period_id,
         to_char(fp.starts_on, 'YYYY-MM')          as fiscal_period_code,
         b.currency                                as currency,
         b.debit                                   as debit,
         b.credit                                  as credit,
         b.base_debit                              as base_debit,
         b.base_credit                             as base_credit,
         (b.base_debit - b.base_credit)            as base_balance`,
  defaultOrder: (tx) => tx`ac.code asc, fp.starts_on asc, b.currency asc`,
});

// ── account — the chart of accounts ──────────────────────────────────────────────────────────────────
const ACCOUNT_COLUMNS: readonly DatasetColumn[] = [
  { field: "account_id", kind: "uuid", ref: (tx) => tx`ac.id` },
  { field: "code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`ac.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`ac.name_ar` },
  { field: "account_type", kind: "text", ref: (tx) => tx`ac.type::text` },
  { field: "parent_id", kind: "uuid", ref: (tx) => tx`ac.parent_id` },
  { field: "parent_code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "is_group", kind: "boolean", ref: (tx) => tx`ac.is_group` },
  { field: "currency", kind: "text", ref: (tx) => tx`ac.currency` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`ac.archived_at` },
];

export const accountDataset: Dataset = defineDataset({
  id: "account",
  columns: ACCOUNT_COLUMNS,
  company: (tx, companyId) => tx`ac.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.account ac left join app.account p on p.id = ac.parent_id`,
  select: (
    tx,
  ) => tx`ac.id as account_id, ac.code as code, ac.name_en as name_en, ac.name_ar as name_ar,
         ac.type::text as account_type, ac.parent_id as parent_id, p.code as parent_code,
         ac.is_group as is_group, ac.currency as currency,
         to_char(ac.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`ac.code asc`,
});

// ── document — the header register, one definition covering every §4.14 type ─────────────────────────
const DOCUMENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "document_id", kind: "uuid", ref: (tx) => tx`d.id` },
  { field: "document_type_id", kind: "uuid", ref: (tx) => tx`d.document_type_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "document_type_module", kind: "text", ref: (tx) => tx`dt.module` },
  { field: "status", kind: "text", ref: (tx) => tx`d.status::text` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`d.effective_date` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`d.fiscal_period_id` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`d.party_id` },
  { field: "party_code", kind: "text", ref: (tx) => tx`pt.code` },
  { field: "party_name_en", kind: "text", ref: (tx) => tx`pt.name_en` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "branch_code", kind: "text", ref: (tx) => tx`bv.code` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`d.warehouse_id` },
  { field: "to_warehouse_id", kind: "uuid", ref: (tx) => tx`d.to_warehouse_id` },
  { field: "currency", kind: "text", ref: (tx) => tx`d.currency` },
  { field: "exchange_rate", kind: "numeric", ref: (tx) => tx`d.exchange_rate` },
  { field: "rate_source", kind: "text", ref: (tx) => tx`d.rate_source` },
  { field: "tax_inclusive", kind: "boolean", ref: (tx) => tx`d.tax_inclusive` },
  { field: "posting_seq", kind: "integer", ref: (tx) => tx`d.posting_seq` },
  { field: "posted_at", kind: "timestamp", ref: (tx) => tx`d.posted_at` },
  { field: "created_at", kind: "timestamp", ref: (tx) => tx`d.created_at` },
  { field: "reverses_document_id", kind: "uuid", ref: (tx) => tx`d.reverses_document_id` },
  {
    field: "base_total",
    kind: "numeric",
    ref: (tx) => tx`coalesce(t.base_total, 0::numeric(19,4))`,
  },
];

export const documentDataset: Dataset = defineDataset({
  id: "document",
  columns: DOCUMENT_COLUMNS,
  company: (tx, companyId) => tx`d.company_id = ${companyId}::uuid`,
  // The total is Σ base debit of the document's own ledger lines — read from the ledger, never recomputed
  // from the lines' amounts (spec:2041 "stored base amounts are never recomputed on read").
  from: (tx) => tx`app.document d
        join app.document_type   dt on dt.id = d.document_type_id
        join app.dimension_value bv on bv.id = d.branch_id
        left join app.party      pt on pt.id = d.party_id
        left join lateral (select sum(le.base_debit) as base_total
                             from app.ledger_entry le
                            where le.document_id = d.id) t on true`,
  select: (
    tx,
  ) => tx`d.id as document_id, d.document_type_id as document_type_id, dt.code as document_type_code,
         dt.module as document_type_module, d.status::text as status, d.series as series, d.number::int as number,
         to_char(d.effective_date, 'YYYY-MM-DD') as effective_date, d.fiscal_period_id as fiscal_period_id,
         d.party_id as party_id, pt.code as party_code, pt.name_en as party_name_en,
         d.branch_id as branch_id, bv.code as branch_code,
         d.warehouse_id as warehouse_id, d.to_warehouse_id as to_warehouse_id, d.currency as currency,
         d.exchange_rate as exchange_rate, d.rate_source as rate_source, d.tax_inclusive as tax_inclusive,
         d.posting_seq::int as posting_seq,
         to_char(d.posted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as posted_at,
         to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
         d.reverses_document_id as reverses_document_id,
         coalesce(t.base_total, 0::numeric(19,4)) as base_total`,
  defaultOrder: (tx) => tx`d.effective_date desc, d.series asc, d.number desc nulls last, d.id asc`,
});

// ── document_line — the generic line, every §4.3.4 column a report can read ──────────────────────────
const DOCUMENT_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "line_id", kind: "uuid", ref: (tx) => tx`dl.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`dl.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "status", kind: "text", ref: (tx) => tx`d.status::text` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`d.effective_date` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`d.party_id` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`dl.line_no` },
  { field: "kind", kind: "text", ref: (tx) => tx`dl.kind` },
  { field: "description", kind: "text", ref: (tx) => tx`dl.description` },
  { field: "account_id", kind: "uuid", ref: (tx) => tx`dl.account_id` },
  { field: "account_code", kind: "text", ref: (tx) => tx`ac.code` },
  { field: "item_id", kind: "uuid", ref: (tx) => tx`dl.item_id` },
  { field: "item_code", kind: "text", ref: (tx) => tx`it.code` },
  { field: "item_name_en", kind: "text", ref: (tx) => tx`it.name_en` },
  { field: "warehouse_id", kind: "uuid", ref: (tx) => tx`dl.warehouse_id` },
  { field: "lot_id", kind: "uuid", ref: (tx) => tx`dl.lot_id` },
  { field: "unit_id", kind: "uuid", ref: (tx) => tx`dl.unit_id` },
  { field: "quantity", kind: "numeric", ref: (tx) => tx`dl.quantity` },
  { field: "unit_quantity", kind: "numeric", ref: (tx) => tx`dl.unit_quantity` },
  { field: "unit_price", kind: "numeric", ref: (tx) => tx`dl.unit_price` },
  { field: "discount", kind: "numeric", ref: (tx) => tx`dl.discount` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`dl.amount` },
  { field: "tax_code_id", kind: "uuid", ref: (tx) => tx`dl.tax_code_id` },
  { field: "tax_amount", kind: "numeric", ref: (tx) => tx`dl.tax_amount` },
  { field: "total_incl_tax", kind: "numeric", ref: (tx) => tx`dl.total_incl_tax` },
  // The line's booked cost is a COST read (3B; the export omits it too, ADR 0069): only a definition gated on
  // `inventory.cost.read` may name it — which `document_line`'s gate set never is (second review, finding 5).
  costRead({ field: "cost", kind: "numeric", ref: (tx) => tx`dl.cost` }),
  { field: "debit", kind: "numeric", ref: (tx) => tx`dl.debit` },
  { field: "credit", kind: "numeric", ref: (tx) => tx`dl.credit` },
];

export const documentLineDataset: Dataset = defineDataset({
  id: "document_line",
  columns: DOCUMENT_LINE_COLUMNS,
  company: (tx, companyId) => tx`dl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.document_line dl
        join app.document      d  on d.id  = dl.document_id
        join app.document_type dt on dt.id = d.document_type_id
        left join app.account  ac on ac.id = dl.account_id
        left join app.item     it on it.id = dl.item_id`,
  select: (tx) => tx`dl.id as line_id, dl.document_id as document_id, dt.code as document_type_code,
         d.status::text as status, to_char(d.effective_date, 'YYYY-MM-DD') as effective_date,
         d.branch_id as branch_id, d.party_id as party_id, dl.line_no as line_no, dl.kind as kind,
         dl.description as description, dl.account_id as account_id, ac.code as account_code,
         dl.item_id as item_id, it.code as item_code, it.name_en as item_name_en,
         dl.warehouse_id as warehouse_id, dl.lot_id as lot_id, dl.unit_id as unit_id,
         dl.quantity as quantity, dl.unit_quantity as unit_quantity, dl.unit_price as unit_price,
         dl.discount as discount, dl.amount as amount, dl.tax_code_id as tax_code_id,
         dl.tax_amount as tax_amount, dl.total_incl_tax as total_incl_tax,
         dl.cost as cost, dl.debit as debit, dl.credit as credit`,
  defaultOrder: (tx) => tx`d.effective_date desc, dl.document_id asc, dl.line_no asc`,
});

// ── document_event — the auditor's view of every transition and override (spec:2163) ─────────────────
const DOCUMENT_EVENT_COLUMNS: readonly DatasetColumn[] = [
  { field: "event_id", kind: "uuid", ref: (tx) => tx`de.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`de.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "event_kind", kind: "text", ref: (tx) => tx`de.event_kind` },
  { field: "from_status", kind: "text", ref: (tx) => tx`de.from_status::text` },
  { field: "to_status", kind: "text", ref: (tx) => tx`de.to_status::text` },
  { field: "override_code", kind: "text", ref: (tx) => tx`de.override_code` },
  { field: "actor_id", kind: "uuid", ref: (tx) => tx`de.actor_id` },
  { field: "actor_display_name", kind: "text", ref: (tx) => tx`ap.display_name` },
  { field: "attributed_to", kind: "uuid", ref: (tx) => tx`de.attributed_to` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`de.occurred_at` },
  { field: "reason", kind: "text", ref: (tx) => tx`de.reason` },
];

export const documentEventDataset: Dataset = defineDataset({
  id: "document_event",
  columns: DOCUMENT_EVENT_COLUMNS,
  company: (tx, companyId) => tx`de.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.document_event de
        join app.document      d  on d.id  = de.document_id
        join app.document_type dt on dt.id = d.document_type_id
        join app.principal     ap on ap.id = de.actor_id`,
  select: (
    tx,
  ) => tx`de.id as event_id, de.document_id as document_id, dt.code as document_type_code,
         d.series as series, d.number::int as number, d.branch_id as branch_id, de.event_kind as event_kind,
         de.from_status::text as from_status, de.to_status::text as to_status,
         de.override_code as override_code, de.actor_id as actor_id, ap.display_name as actor_display_name,
         de.attributed_to as attributed_to,
         to_char(de.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
         de.reason as reason`,
  defaultOrder: (tx) => tx`de.occurred_at desc, de.id desc`,
});

// ── audit_log — TENANT-scoped: app.audit_log has no company_id (plan0A:1920) ─────────────────────────
const AUDIT_LOG_COLUMNS: readonly DatasetColumn[] = [
  { field: "seq", kind: "integer", ref: (tx) => tx`al.seq` },
  { field: "occurred_at", kind: "timestamp", ref: (tx) => tx`al.occurred_at` },
  { field: "table_name", kind: "text", ref: (tx) => tx`al.table_name` },
  { field: "row_id", kind: "text", ref: (tx) => tx`al.row_id` },
  { field: "action", kind: "text", ref: (tx) => tx`al.action` },
  { field: "actor_id", kind: "uuid", ref: (tx) => tx`al.actor_id` },
  { field: "actor_display_name", kind: "text", ref: (tx) => tx`ap.display_name` },
  { field: "actor_kind", kind: "text", ref: (tx) => tx`ap.kind::text` },
  // NO `before`/`after` (Phase 7 review, finding 1). The row images are of every table, the gated ones
  // included, so a definition printing them reads payroll, cost and tax rows under the audit code alone —
  // the reason `NEVER_EXPORTED.audit_log` pins both and 7B's audit report never printed them. A dataset may
  // not serve a column the export registry pins (`definition-gates.test.ts`).
];

export const auditLogDataset: Dataset = defineDataset({
  id: "audit_log",
  columns: AUDIT_LOG_COLUMNS,
  company: null,
  from: (tx) => tx`app.audit_log al join app.principal ap on ap.id = al.actor_id`,
  // `seq` is the global bigserial behind the hash chain, so it is emitted as int8 — which postgres.js returns
  // as a decimal STRING — and never narrowed to int4: a cast that overflows at 2^31 rows would turn the
  // auditor's report into a 500. Every other `integer` column below is a per-series or per-line counter.
  select: (tx) => tx`al.seq as seq,
         to_char(al.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as occurred_at,
         al.table_name as table_name, al.row_id as row_id, al.action as action,
         al.actor_id as actor_id, ap.display_name as actor_display_name, ap.kind::text as actor_kind`,
  defaultOrder: (tx) => tx`al.seq desc`,
});

// ── tax_transaction — written only by the posting service; append-only (§4.9.2) ──────────────────────
const TAX_TRANSACTION_COLUMNS: readonly DatasetColumn[] = [
  { field: "transaction_id", kind: "uuid", ref: (tx) => tx`tt.id` },
  { field: "document_id", kind: "uuid", ref: (tx) => tx`tt.document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "series", kind: "text", ref: (tx) => tx`d.series` },
  { field: "number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "branch_id", kind: "uuid", ref: (tx) => tx`d.branch_id` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`d.party_id` },
  { field: "party_tax_registration", kind: "text", ref: (tx) => tx`pt.tax_registration` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`tt.line_no` },
  { field: "tax_code_id", kind: "uuid", ref: (tx) => tx`tt.tax_code_id` },
  { field: "tax_code", kind: "text", ref: (tx) => tx`tc.code` },
  { field: "tax_code_kind", kind: "text", ref: (tx) => tx`tc.kind` },
  { field: "tax_rate", kind: "numeric", ref: (tx) => tx`tc.rate` },
  { field: "regime_id", kind: "uuid", ref: (tx) => tx`tt.regime_id` },
  { field: "regime_code", kind: "text", ref: (tx) => tx`tr.code` },
  { field: "base", kind: "numeric", ref: (tx) => tx`tt.base` },
  { field: "tax", kind: "numeric", ref: (tx) => tx`tt.tax` },
  { field: "base_base", kind: "numeric", ref: (tx) => tx`tt.base_base` },
  { field: "tax_base", kind: "numeric", ref: (tx) => tx`tt.tax_base` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`tt.effective_date` },
  { field: "fiscal_period_id", kind: "uuid", ref: (tx) => tx`tt.fiscal_period_id` },
  {
    field: "fiscal_period_code",
    kind: "text",
    ref: (tx) => tx`to_char(fp.starts_on, 'YYYY-MM')`,
  },
  { field: "posting_seq", kind: "integer", ref: (tx) => tx`tt.posting_seq` },
];

export const taxTransactionDataset: Dataset = defineDataset({
  id: "tax_transaction",
  columns: TAX_TRANSACTION_COLUMNS,
  company: (tx, companyId) => tx`tt.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.tax_transaction tt
        join app.document      d  on d.id  = tt.document_id
        join app.document_type dt on dt.id = d.document_type_id
        join app.tax_code      tc on tc.id = tt.tax_code_id
        join app.tax_regime    tr on tr.id = tt.regime_id
        join app.fiscal_period fp on fp.id = tt.fiscal_period_id
        left join app.party    pt on pt.id = d.party_id`,
  select: (
    tx,
  ) => tx`tt.id as transaction_id, tt.document_id as document_id, dt.code as document_type_code,
         d.series as series, d.number::int as number, d.branch_id as branch_id, d.party_id as party_id,
         pt.tax_registration as party_tax_registration, tt.line_no as line_no,
         tt.tax_code_id as tax_code_id, tc.code as tax_code, tc.kind as tax_code_kind, tc.rate as tax_rate,
         tt.regime_id as regime_id, tr.code as regime_code,
         tt.base as base, tt.tax as tax, tt.base_base as base_base, tt.tax_base as tax_base,
         to_char(tt.effective_date, 'YYYY-MM-DD') as effective_date, tt.fiscal_period_id as fiscal_period_id,
         to_char(fp.starts_on, 'YYYY-MM') as fiscal_period_code, tt.posting_seq::int as posting_seq`,
  defaultOrder: (tx) => tx`tt.effective_date asc, tt.posting_seq asc, tt.line_no asc`,
});
