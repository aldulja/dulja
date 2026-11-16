import { defineDataset, type Dataset, type DatasetColumn } from "../query";

/**
 * The AR/AP datasets (§4.16.2's 4A/4B sources). Same rules as `accounting.ts`: every `ref` is a literal
 * tagged template, dates and timestamps leave SQL as strings, numerics stay postgres.js strings.
 *
 * `pdc` is not here: 4B's `app.pdc` is migration 0051, which is reserved and unused because OD-09
 * (post-dated cheques) was not built, and §4.16.2 drops the id together with the table.
 */

// ── party — customers and vendors (§4.5.7); 4A's credit columns included ────────────────────────────
const PARTY_COLUMNS: readonly DatasetColumn[] = [
  { field: "party_id", kind: "uuid", ref: (tx) => tx`p.id` },
  { field: "kind", kind: "text", ref: (tx) => tx`p.kind` },
  { field: "code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`p.name_ar` },
  { field: "currency", kind: "text", ref: (tx) => tx`p.currency` },
  { field: "tax_registration", kind: "text", ref: (tx) => tx`p.tax_registration` },
  { field: "email", kind: "text", ref: (tx) => tx`p.email` },
  { field: "phone", kind: "text", ref: (tx) => tx`p.phone` },
  { field: "receivable_account_id", kind: "uuid", ref: (tx) => tx`p.receivable_account_id` },
  { field: "receivable_account_code", kind: "text", ref: (tx) => tx`ra.code` },
  { field: "payable_account_id", kind: "uuid", ref: (tx) => tx`p.payable_account_id` },
  { field: "payable_account_code", kind: "text", ref: (tx) => tx`pa.code` },
  { field: "credit_limit", kind: "numeric", ref: (tx) => tx`p.credit_limit` },
  { field: "credit_hold", kind: "boolean", ref: (tx) => tx`p.credit_hold` },
  { field: "payment_term_id", kind: "uuid", ref: (tx) => tx`p.payment_term_id` },
  { field: "payment_term_code", kind: "text", ref: (tx) => tx`ptm.code` },
  { field: "price_list_id", kind: "uuid", ref: (tx) => tx`p.price_list_id` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`p.archived_at` },
];

export const partyDataset: Dataset = defineDataset({
  id: "party",
  columns: PARTY_COLUMNS,
  company: (tx, companyId) => tx`p.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.party p
        left join app.account      ra  on ra.id  = p.receivable_account_id
        left join app.account      pa  on pa.id  = p.payable_account_id
        left join app.payment_term ptm on ptm.id = p.payment_term_id`,
  select: (
    tx,
  ) => tx`p.id as party_id, p.kind as kind, p.code as code, p.name_en as name_en, p.name_ar as name_ar,
         p.currency as currency, p.tax_registration as tax_registration, p.email as email, p.phone as phone,
         p.receivable_account_id as receivable_account_id, ra.code as receivable_account_code,
         p.payable_account_id as payable_account_id, pa.code as payable_account_code,
         p.credit_limit as credit_limit, p.credit_hold as credit_hold,
         p.payment_term_id as payment_term_id, ptm.code as payment_term_code, p.price_list_id as price_list_id,
         to_char(p.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`p.kind asc, p.code asc`,
});

// ── party_ageing — 4B's ASYNC projection, rebuilt nightly; never recomputed here (spec:1204) ─────────
const PARTY_AGEING_COLUMNS: readonly DatasetColumn[] = [
  { field: "party_id", kind: "uuid", ref: (tx) => tx`pa.party_id` },
  { field: "party_code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "party_name_en", kind: "text", ref: (tx) => tx`p.name_en` },
  { field: "party_name_ar", kind: "text", ref: (tx) => tx`p.name_ar` },
  { field: "party_kind", kind: "text", ref: (tx) => tx`p.kind` },
  { field: "currency", kind: "text", ref: (tx) => tx`pa.currency` },
  { field: "as_of", kind: "date", ref: (tx) => tx`pa.as_of` },
  { field: "bucket", kind: "text", ref: (tx) => tx`pa.bucket` },
  // 0 … 4 in 4B's bucket order (0048's CHECK: current, 1_30, 31_60, 61_90, over_90). A definition sorts on
  // this, never on `bucket`, whose text order puts `current` between `61_90` and `over_90`.
  {
    field: "bucket_rank",
    kind: "integer",
    ref: (tx) =>
      tx`(array_position(array['current','1_30','31_60','61_90','over_90'], pa.bucket) - 1)`,
  },
  { field: "amount", kind: "numeric", ref: (tx) => tx`pa.amount` },
  { field: "base_amount", kind: "numeric", ref: (tx) => tx`pa.base_amount` },
];

export const partyAgeingDataset: Dataset = defineDataset({
  id: "party_ageing",
  columns: PARTY_AGEING_COLUMNS,
  company: (tx, companyId) => tx`pa.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.party_ageing pa join app.party p on p.id = pa.party_id`,
  select: (tx) => tx`pa.party_id as party_id, p.code as party_code, p.name_en as party_name_en,
         p.name_ar as party_name_ar, p.kind as party_kind,
         pa.currency as currency, to_char(pa.as_of, 'YYYY-MM-DD') as as_of, pa.bucket as bucket,
         (array_position(array['current','1_30','31_60','61_90','over_90'], pa.bucket) - 1)::int as bucket_rank,
         pa.amount as amount, pa.base_amount as base_amount`,
  // The bucket order the ageing report prints in is the projection's own vocabulary order (0048's CHECK),
  // not alphabetical.
  defaultOrder: (tx) => tx`p.code asc, pa.currency asc,
         array_position(array['current','1_30','31_60','61_90','over_90'], pa.bucket) asc`,
});

// ── allocation — which settlement paid which document (§4.8.1) ──────────────────────────────────────
const ALLOCATION_COLUMNS: readonly DatasetColumn[] = [
  { field: "allocation_id", kind: "uuid", ref: (tx) => tx`al.id` },
  { field: "party_id", kind: "uuid", ref: (tx) => tx`al.party_id` },
  { field: "party_code", kind: "text", ref: (tx) => tx`p.code` },
  { field: "settlement_document_id", kind: "uuid", ref: (tx) => tx`al.settlement_document_id` },
  { field: "settlement_type_code", kind: "text", ref: (tx) => tx`st.code` },
  { field: "settlement_number", kind: "integer", ref: (tx) => tx`sd.number` },
  { field: "settled_document_id", kind: "uuid", ref: (tx) => tx`al.settled_document_id` },
  { field: "settled_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "settled_number", kind: "integer", ref: (tx) => tx`dd.number` },
  { field: "settled_effective_date", kind: "date", ref: (tx) => tx`dd.effective_date` },
  { field: "effective_date", kind: "date", ref: (tx) => tx`al.effective_date` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`al.amount` },
  { field: "settlement_amount", kind: "numeric", ref: (tx) => tx`al.settlement_amount` },
  { field: "base_amount", kind: "numeric", ref: (tx) => tx`al.base_amount` },
  { field: "fx_difference", kind: "numeric", ref: (tx) => tx`al.fx_difference` },
  { field: "unallocated_at", kind: "timestamp", ref: (tx) => tx`al.unallocated_at` },
  { field: "unallocated_on", kind: "date", ref: (tx) => tx`al.unallocated_on` },
  { field: "created_at", kind: "timestamp", ref: (tx) => tx`al.created_at` },
];

export const allocationDataset: Dataset = defineDataset({
  id: "allocation",
  columns: ALLOCATION_COLUMNS,
  company: (tx, companyId) => tx`al.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.allocation al
        join app.party         p  on p.id  = al.party_id
        join app.document      sd on sd.id = al.settlement_document_id
        join app.document_type st on st.id = sd.document_type_id
        join app.document      dd on dd.id = al.settled_document_id
        join app.document_type dt on dt.id = dd.document_type_id`,
  select: (tx) => tx`al.id as allocation_id, al.party_id as party_id, p.code as party_code,
         al.settlement_document_id as settlement_document_id, st.code as settlement_type_code,
         sd.number::int as settlement_number, al.settled_document_id as settled_document_id,
         dt.code as settled_type_code, dd.number::int as settled_number,
         to_char(dd.effective_date, 'YYYY-MM-DD') as settled_effective_date,
         to_char(al.effective_date, 'YYYY-MM-DD') as effective_date,
         al.amount as amount, al.settlement_amount as settlement_amount, al.base_amount as base_amount,
         al.fx_difference as fx_difference,
         to_char(al.unallocated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as unallocated_at,
         to_char(al.unallocated_on, 'YYYY-MM-DD') as unallocated_on,
         to_char(al.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at`,
  defaultOrder: (tx) => tx`al.created_at desc, al.id desc`,
});

// ── payment_term ────────────────────────────────────────────────────────────────────────────────────
const PAYMENT_TERM_COLUMNS: readonly DatasetColumn[] = [
  { field: "payment_term_id", kind: "uuid", ref: (tx) => tx`ptm.id` },
  { field: "code", kind: "text", ref: (tx) => tx`ptm.code` },
  { field: "name_en", kind: "text", ref: (tx) => tx`ptm.name_en` },
  { field: "name_ar", kind: "text", ref: (tx) => tx`ptm.name_ar` },
  { field: "due_days", kind: "integer", ref: (tx) => tx`ptm.due_days` },
  { field: "discount_days", kind: "integer", ref: (tx) => tx`ptm.discount_days` },
  { field: "discount_pct", kind: "numeric", ref: (tx) => tx`ptm.discount_pct` },
  { field: "archived_at", kind: "timestamp", ref: (tx) => tx`ptm.archived_at` },
];

export const paymentTermDataset: Dataset = defineDataset({
  id: "payment_term",
  columns: PAYMENT_TERM_COLUMNS,
  company: (tx, companyId) => tx`ptm.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.payment_term ptm`,
  select: (
    tx,
  ) => tx`ptm.id as payment_term_id, ptm.code as code, ptm.name_en as name_en, ptm.name_ar as name_ar,
         ptm.due_days as due_days, ptm.discount_days as discount_days, ptm.discount_pct as discount_pct,
         to_char(ptm.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as archived_at`,
  defaultOrder: (tx) => tx`ptm.due_days asc, ptm.code asc`,
});

// ── bank_statement_line — the imported statement (§4.8.3) ───────────────────────────────────────────
const BANK_STATEMENT_LINE_COLUMNS: readonly DatasetColumn[] = [
  { field: "line_id", kind: "uuid", ref: (tx) => tx`bl.id` },
  { field: "statement_id", kind: "uuid", ref: (tx) => tx`bl.statement_id` },
  { field: "statement_date", kind: "date", ref: (tx) => tx`bs.statement_date` },
  { field: "bank_account_id", kind: "uuid", ref: (tx) => tx`bs.bank_account_id` },
  { field: "bank_account_code", kind: "text", ref: (tx) => tx`ba.code` },
  { field: "currency", kind: "text", ref: (tx) => tx`bs.currency` },
  { field: "line_no", kind: "integer", ref: (tx) => tx`bl.line_no` },
  { field: "value_date", kind: "date", ref: (tx) => tx`bl.value_date` },
  { field: "description", kind: "text", ref: (tx) => tx`bl.description` },
  { field: "reference", kind: "text", ref: (tx) => tx`bl.reference` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`bl.amount` },
  // The "unreconciled items" report is exactly this predicate, so it is a column and not a hand-written
  // report. Only LIVE matches count — an unmatched row (unmatched_at set) is history, not a reconciliation.
  {
    field: "matched_amount",
    kind: "numeric",
    ref: (tx) => tx`coalesce(m.matched, 0::numeric(19,4))`,
  },
  { field: "is_matched", kind: "boolean", ref: (tx) => tx`(coalesce(m.matched, 0) = bl.amount)` },
];

export const bankStatementLineDataset: Dataset = defineDataset({
  id: "bank_statement_line",
  columns: BANK_STATEMENT_LINE_COLUMNS,
  company: (tx, companyId) => tx`bl.company_id = ${companyId}::uuid`,
  from: (tx) => tx`app.bank_statement_line bl
        join app.bank_statement bs on bs.id = bl.statement_id
        join app.account        ba on ba.id = bs.bank_account_id
        left join lateral (select sum(bm.amount) as matched
                             from app.bank_match bm
                            where bm.statement_line_id = bl.id and bm.unmatched_at is null) m on true`,
  select: (tx) => tx`bl.id as line_id, bl.statement_id as statement_id,
         to_char(bs.statement_date, 'YYYY-MM-DD') as statement_date,
         bs.bank_account_id as bank_account_id, ba.code as bank_account_code, bs.currency as currency,
         bl.line_no as line_no, to_char(bl.value_date, 'YYYY-MM-DD') as value_date,
         bl.description as description, bl.reference as reference, bl.amount as amount,
         coalesce(m.matched, 0::numeric(19,4)) as matched_amount,
         (coalesce(m.matched, 0) = bl.amount) as is_matched`,
  defaultOrder: (tx) => tx`bs.statement_date asc, bl.statement_id asc, bl.line_no asc`,
});

// ── bank_match — the reconciliation trail; never alters a ledger entry (spec:2457) ───────────────────
const BANK_MATCH_COLUMNS: readonly DatasetColumn[] = [
  { field: "match_id", kind: "uuid", ref: (tx) => tx`bm.id` },
  { field: "statement_line_id", kind: "uuid", ref: (tx) => tx`bm.statement_line_id` },
  { field: "value_date", kind: "date", ref: (tx) => tx`bl.value_date` },
  { field: "bank_account_id", kind: "uuid", ref: (tx) => tx`bs.bank_account_id` },
  // 0050's CHECK: receipt | payment | till_banking | payroll_batch.
  { field: "reconcilable_kind", kind: "text", ref: (tx) => tx`bm.reconcilable_kind` },
  { field: "reconcilable_document_id", kind: "uuid", ref: (tx) => tx`bm.reconcilable_document_id` },
  { field: "document_type_code", kind: "text", ref: (tx) => tx`dt.code` },
  { field: "document_number", kind: "integer", ref: (tx) => tx`d.number` },
  { field: "amount", kind: "numeric", ref: (tx) => tx`bm.amount` },
  { field: "matched_at", kind: "timestamp", ref: (tx) => tx`bm.matched_at` },
  { field: "unmatched_at", kind: "timestamp", ref: (tx) => tx`bm.unmatched_at` },
  { field: "unmatch_reason", kind: "text", ref: (tx) => tx`bm.unmatch_reason` },
];

export const bankMatchDataset: Dataset = defineDataset({
  id: "bank_match",
  columns: BANK_MATCH_COLUMNS,
  company: (tx, companyId) => tx`bm.company_id = ${companyId}::uuid`,
  // An inner join to the document on purpose: a branch-restricted reader whose `branch_isolation` hides the
  // matched document does not see the match either (Form A on app.document, 0068).
  from: (tx) => tx`app.bank_match bm
        join app.bank_statement_line bl on bl.id = bm.statement_line_id
        join app.bank_statement      bs on bs.id = bl.statement_id
        join app.document            d  on d.id  = bm.reconcilable_document_id
        join app.document_type       dt on dt.id = d.document_type_id`,
  select: (tx) => tx`bm.id as match_id, bm.statement_line_id as statement_line_id,
         to_char(bl.value_date, 'YYYY-MM-DD') as value_date, bs.bank_account_id as bank_account_id,
         bm.reconcilable_kind as reconcilable_kind, bm.reconcilable_document_id as reconcilable_document_id,
         dt.code as document_type_code, d.number::int as document_number, bm.amount as amount,
         to_char(bm.matched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as matched_at,
         to_char(bm.unmatched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as unmatched_at,
         bm.unmatch_reason as unmatch_reason`,
  defaultOrder: (tx) => tx`bm.matched_at desc, bm.id desc`,
});
