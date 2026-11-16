import type { Sql } from "postgres";

export interface LedgerParams {
  companyId: string;
  accountId: string;
  /** Inclusive, on effective_date — the accounting date, never posted_at (spec:2039). */
  fromDate: string;
  toDate: string;
  /**
   * Keyset position: the chronological key of the last row of the previous page. It carries NO amount —
   * the running-balance seed for page N + 1 is recomputed here from the ledger, never read back from the
   * client (a cursor is base64url, not signed, and money arithmetic must not be seeded from a client value).
   */
  cursor?: { effectiveDate: string; postingSeq: string; lineNo: number } | null | undefined;
  limit: number;
}

export interface LedgerRow {
  entryId: string;
  effectiveDate: string;
  documentId: string;
  documentTypeCode: string;
  series: string;
  /** bigint as a string; null is impossible for a posted document but the column is nullable. */
  number: string | null;
  lineNo: number;
  postingSeq: string;
  currency: string;
  exchangeRate: string;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
  /** Opening balance plus every movement up to and including this row, in base. */
  runningBaseBalance: string;
}

/**
 * The balance brought forward: every base movement on the account strictly before `beforeDate`.
 * Signed as debit − credit, so an asset carries a positive brought-forward figure.
 */
export async function accountOpeningBalance(
  tx: Sql,
  params: { companyId: string; accountId: string; beforeDate: string },
): Promise<string> {
  const [row] = await tx<{ opening: string }[]>`
    select coalesce(sum(l.base_debit - l.base_credit), 0)::numeric(19,4)::text as opening
      from app.ledger_entry l
     where l.company_id     = ${params.companyId}
       and l.account_id     = ${params.accountId}
       and l.effective_date < ${params.beforeDate}::date`;
  return row!.opening;
}

/**
 * The `accounting.ledger` dataset (§4.16.1): one account's entries over a date range, with a running
 * base balance. The chronological key is (effective_date, document.posting_seq, line_no) — posting_seq
 * is the total order within a company that §4.3.5 defines and §4.3.2 step 8 assigns before any row that
 * carries it, so two documents with the same effective_date still order deterministically.
 *
 * The window sum runs over the rows this page selects and is seeded with the opening balance plus every
 * movement up to and including the cursor's row — recomputed from ledger_entry on every page, so paging
 * never restarts the arithmetic and never trusts a number the client sent back.
 *
 * There is no join to document_line: ledger_entry.line_no is the LEDGER line ordinal (it carries
 * `unique (document_id, line_no)` and a policy may emit several ledger lines per document line), so a
 * join on it would be wrong. The document's type, series and number identify the row instead.
 */
export async function accountLedger(tx: Sql, params: LedgerParams): Promise<LedgerRow[]> {
  const opening = await accountOpeningBalance(tx, {
    companyId: params.companyId,
    accountId: params.accountId,
    beforeDate: params.fromDate,
  });
  const cursorDate = params.cursor?.effectiveDate ?? null;
  const cursorSeq = params.cursor?.postingSeq ?? null;
  const cursorLine = params.cursor?.lineNo ?? null;

  // The balance the previous pages ended on: opening plus every in-range movement up to and including the
  // cursor's own row. `<=` on the same three-column key the page predicate uses `>` on, so the two are a
  // partition of the range and no row is counted twice or skipped.
  let seed = opening;
  if (params.cursor) {
    const [carried] = await tx<{ carried: string }[]>`
      select (${opening}::numeric(19,4) + coalesce(sum(l.base_debit - l.base_credit), 0))::numeric(19,4)::text
               as carried
        from app.ledger_entry l
        join app.document d on d.id = l.document_id
       where l.company_id      = ${params.companyId}
         and l.account_id      = ${params.accountId}
         and l.effective_date >= ${params.fromDate}::date
         and l.effective_date <= ${params.toDate}::date
         and (l.effective_date, d.posting_seq, l.line_no)
             <= (${cursorDate}::date, ${cursorSeq}::bigint, ${cursorLine}::int)`;
    seed = carried!.carried;
  }

  const rows = await tx<
    {
      entry_id: string;
      effective_date: string;
      document_id: string;
      document_type_code: string;
      series: string;
      number: string | null;
      line_no: number;
      posting_seq: string;
      currency: string;
      exchange_rate: string;
      debit: string;
      credit: string;
      base_debit: string;
      base_credit: string;
      running_base_balance: string;
    }[]
  >`
    select l.id::text             as entry_id,
           l.effective_date::text as effective_date,
           l.document_id::text    as document_id,
           dt.code                as document_type_code,
           d.series               as series,
           d.number::text         as number,
           l.line_no              as line_no,
           d.posting_seq::text    as posting_seq,
           l.currency::text       as currency,
           l.exchange_rate::text  as exchange_rate,
           l.debit::text          as debit,
           l.credit::text         as credit,
           l.base_debit::text     as base_debit,
           l.base_credit::text    as base_credit,
           (${seed}::numeric(19,4)
             + sum(l.base_debit - l.base_credit) over (
                 order by l.effective_date, d.posting_seq, l.line_no
                 rows between unbounded preceding and current row))::numeric(19,4)::text
                                  as running_base_balance
      from app.ledger_entry l
      join app.document d on d.id = l.document_id
      join app.document_type dt on dt.id = d.document_type_id
     where l.company_id      = ${params.companyId}
       and l.account_id      = ${params.accountId}
       and l.effective_date >= ${params.fromDate}::date
       and l.effective_date <= ${params.toDate}::date
       and (${cursorDate}::date is null
            or (l.effective_date, d.posting_seq, l.line_no)
               > (${cursorDate}::date, ${cursorSeq}::bigint, ${cursorLine}::int))
     order by l.effective_date, d.posting_seq, l.line_no
     limit ${params.limit}`;

  return rows.map((row) => ({
    entryId: row.entry_id,
    effectiveDate: row.effective_date,
    documentId: row.document_id,
    documentTypeCode: row.document_type_code,
    series: row.series,
    number: row.number,
    lineNo: row.line_no,
    postingSeq: row.posting_seq,
    currency: row.currency,
    exchangeRate: row.exchange_rate,
    debit: row.debit,
    credit: row.credit,
    baseDebit: row.base_debit,
    baseCredit: row.base_credit,
    runningBaseBalance: row.running_base_balance,
  }));
}
