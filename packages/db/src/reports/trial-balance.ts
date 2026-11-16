import type { Sql } from "postgres";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface TrialBalanceParams {
  companyId: string;
  fiscalPeriodId: string;
  /** Restrict to one document currency. Omitted: every currency the period has balances in. */
  currency?: string | undefined;
  /** Keyset position: the last row of the previous page. */
  cursor?: { accountCode: string; currency: string } | null | undefined;
  limit: number;
}

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountNameEn: string;
  accountNameAr: string | null;
  accountType: AccountType;
  currency: string;
  /** Fixed 4 dp strings, exactly as stored — "stored base amounts are never recomputed on read" (spec:2041). */
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
}

/**
 * The `accounting.trial_balance` dataset (§4.16.1, spec:2300's minimal set). It reads the SYNCHRONOUS
 * projection app.account_balance, which the posting service MERGEs in the posting transaction (D14,
 * §4.3.3) — so a trial balance is exact the instant a document posts (spec:1204). It never re-aggregates
 * ledger_entry: that is the integrity job's business, and a report that quietly recomputed would hide
 * exactly the drift the job exists to find.
 *
 * Keyset pagination on (account.code, currency); both are text, and both are in the ORDER BY, so the
 * page boundary is total.
 */
export async function trialBalance(
  tx: Sql,
  params: TrialBalanceParams,
): Promise<TrialBalanceRow[]> {
  const currency = params.currency ?? null;
  const cursorCode = params.cursor?.accountCode ?? null;
  const cursorCurrency = params.cursor?.currency ?? null;

  const rows = await tx<
    {
      account_id: string;
      code: string;
      name_en: string;
      name_ar: string | null;
      type: AccountType;
      currency: string;
      debit: string;
      credit: string;
      base_debit: string;
      base_credit: string;
    }[]
  >`
    select b.account_id::text, a.code, a.name_en, a.name_ar, a.type::text as type,
           b.currency::text    as currency,
           b.debit::text       as debit,
           b.credit::text      as credit,
           b.base_debit::text  as base_debit,
           b.base_credit::text as base_credit
      from app.account_balance b
      join app.account a on a.id = b.account_id
     where b.company_id       = ${params.companyId}
       and b.fiscal_period_id = ${params.fiscalPeriodId}
       and (${currency}::text is null or b.currency::text = ${currency})
       and (${cursorCode}::text is null
            or (a.code, b.currency::text) > (${cursorCode}::text, ${cursorCurrency}::text))
     order by a.code, b.currency
     limit ${params.limit}`;

  return rows.map((row) => ({
    accountId: row.account_id,
    accountCode: row.code,
    accountNameEn: row.name_en,
    accountNameAr: row.name_ar,
    accountType: row.type,
    currency: row.currency,
    debit: row.debit,
    credit: row.credit,
    baseDebit: row.base_debit,
    baseCredit: row.base_credit,
  }));
}

/**
 * A deterministic sha256 over the whole trial balance of one company (optionally one period), in a
 * fixed row and column order. Acceptance test 24 compares this figure across a point-in-time restore:
 * "the trial balance computed from the restored ledger equals the trial balance the live system
 * reported at that timestamp" (spec:2442). Hashing in SQL keeps the comparison free of any JavaScript
 * number and of any locale-dependent formatting.
 */
export async function trialBalanceFingerprint(
  tx: Sql,
  params: { companyId: string; fiscalPeriodId?: string | undefined },
): Promise<string> {
  const periodId = params.fiscalPeriodId ?? null;
  const [row] = await tx<{ fingerprint: string }[]>`
    select encode(sha256(convert_to(coalesce(string_agg(
             b.account_id::text || '|' || b.fiscal_period_id::text || '|' || b.currency || '|' ||
             b.debit::text || '|' || b.credit::text || '|' || b.base_debit::text || '|' || b.base_credit::text,
             E'\n' order by b.account_id, b.fiscal_period_id, b.currency), ''), 'UTF8')), 'hex') as fingerprint
      from app.account_balance b
     where b.company_id = ${params.companyId}
       and (${periodId}::uuid is null or b.fiscal_period_id = ${periodId})`;
  return row!.fingerprint;
}
