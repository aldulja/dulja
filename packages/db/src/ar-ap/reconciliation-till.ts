import type { Sql } from "postgres";
import { Money, currency } from "@dulja/domain";
import {
  registerReconcilableSource,
  type Reconcilable,
  type ReconcilableSource,
} from "./reconciliation";

/**
 * The `till_banking` source (6D Task 11, ⚠️ OD-10 answered yes 2026-11-04). **4B's `reconciliation.ts` is
 * not edited**: its `reconcilable_kind` CHECK and `RECONCILABLE_DIRECTION` already admit `till_banking`
 * (§4.8.3), and 6D adds this one `registerReconcilableSource` call.
 *
 * It lists from `app.till_banking_link` (contracts amendment A16), whose `bank_account_id`, `value_date` and
 * `amount` are the banking document's `1100` leg — written from the same document in the posting savepoint —
 * plus the shift, which no ledger leg carries. `value_date` is the document's `effective_date`, which is the
 * one-day window `match` resolves a document over. `unmatchedOnly` uses 4B's own `bank_match` subquery
 * shape, restricted to this bank account's statements, so the two sources behave alike at the margins (a
 * partly matched banking is still listed).
 */
export const tillBankingSource: ReconcilableSource = {
  kind: "till_banking",
  async list(tx: Sql, input): Promise<Reconcilable[]> {
    const rows = await tx<
      {
        document_id: string;
        value_date: string;
        amount: string;
        currency: string;
        reference: string | null;
      }[]
    >`
      select l.banking_document_id::text as document_id, l.value_date::text as value_date,
             l.amount::text as amount, l.currency,
             nullif(concat_ws(' ', nullif(concat_ws('-', d.series, d.number::text), ''), l.reference), '')
               as reference
        from app.till_banking_link l
        join app.document d on d.id = l.banking_document_id
       where l.company_id      = ${input.companyId}
         and d.company_id      = ${input.companyId}
         and l.bank_account_id = ${input.bankAccountId}
         and l.value_date between ${input.from}::date and ${input.to}::date
         and d.status in ('posted', 'reversed')
         and (${input.unmatchedOnly}::boolean = false
              or l.amount > coalesce((select sum(bm.amount)
                                        from app.bank_match bm
                                        join app.bank_statement_line sl on sl.id = bm.statement_line_id
                                        join app.bank_statement st on st.id = sl.statement_id
                                       where bm.reconcilable_document_id = l.banking_document_id
                                         and bm.unmatched_at is null
                                         and st.bank_account_id = ${input.bankAccountId}), 0))
       order by l.value_date, l.banking_document_id`;
    return rows.map((r) => ({
      kind: "till_banking" as const,
      documentId: r.document_id,
      bankAccountId: input.bankAccountId,
      valueDate: r.value_date,
      amount: Money.of(r.amount, currency(r.currency)),
      reference: r.reference,
    }));
  },
};

// Module-level, exactly as 4B registers its two; the barrel imports this file, so importing `@dulja/db`
// registers it. `registerReconcilableSource` is a `Map.set` keyed on the kind, so this adds a kind and
// replaces neither of 4B's.
registerReconcilableSource(tillBankingSource);
