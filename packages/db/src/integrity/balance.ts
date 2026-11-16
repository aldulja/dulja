import type { Sql } from "postgres";
import type { LedgerImbalance } from "./types";

export interface LedgerBalanceOptions {
  /** Narrow to one company. Omitted: every company visible under the current tenant. */
  companyId?: string | undefined;
}

/**
 * The ledger-integrity SLI of spec:2246: "Σdebit = Σcredit per tenant/period/company".
 * The tenant half is RLS — this runs inside withTenant, so app.ledger_entry already shows one tenant's
 * rows and no query below mentions tenant_id (contracts §4.2.2). That is the structural answer to
 * SAH-001, where the aggregate was keyed without the tenant.
 *
 * The comparison is in BASE amounts. A revaluation journal legitimately balances only in base
 * (0001 §7), and base is what the deferred ledger_entry_balanced constraint checks per document;
 * this function is the per-PERIOD backstop that constraint cannot express.
 *
 * `byDocument` is therefore unreachable in a healthy database: migration 0001's deferred
 * `ledger_entry_balanced` refuses any transaction that would leave a document unbalanced, so a non-empty
 * `byDocument` means the constraint is absent — a restored or hand-repaired database, or a schema drift.
 * It is kept precisely for that case, and it is what the restore drill checks after a restore.
 *
 * Amounts come back as strings (numeric → string in postgres.js) and are never converted.
 */
export async function checkLedgerBalance(
  tx: Sql,
  opts: LedgerBalanceOptions = {},
): Promise<{ byPeriod: LedgerImbalance[]; byDocument: LedgerImbalance[] }> {
  const companyId = opts.companyId ?? null;

  const periods = await tx<
    {
      company_id: string;
      fiscal_period_id: string;
      base_debit: string;
      base_credit: string;
      difference: string;
    }[]
  >`
    select l.company_id::text,
           l.fiscal_period_id::text,
           sum(l.base_debit)::text                        as base_debit,
           sum(l.base_credit)::text                       as base_credit,
           (sum(l.base_debit) - sum(l.base_credit))::text as difference
      from app.ledger_entry l
     where (${companyId}::uuid is null or l.company_id = ${companyId})
     group by l.company_id, l.fiscal_period_id
    having sum(l.base_debit) <> sum(l.base_credit)
     order by 1, 2`;

  const documents = await tx<
    {
      company_id: string;
      document_id: string;
      base_debit: string;
      base_credit: string;
      difference: string;
    }[]
  >`
    select l.company_id::text,
           l.document_id::text,
           sum(l.base_debit)::text                        as base_debit,
           sum(l.base_credit)::text                       as base_credit,
           (sum(l.base_debit) - sum(l.base_credit))::text as difference
      from app.ledger_entry l
     where (${companyId}::uuid is null or l.company_id = ${companyId})
     group by l.company_id, l.document_id
    having sum(l.base_debit) <> sum(l.base_credit)
     order by 1, 2`;

  return {
    byPeriod: periods.map((row) => ({
      scope: "period" as const,
      companyId: row.company_id,
      subjectId: row.fiscal_period_id,
      baseDebit: row.base_debit,
      baseCredit: row.base_credit,
      difference: row.difference,
    })),
    byDocument: documents.map((row) => ({
      scope: "document" as const,
      companyId: row.company_id,
      subjectId: row.document_id,
      baseDebit: row.base_debit,
      baseCredit: row.base_credit,
      difference: row.difference,
    })),
  };
}
